package com.example.shellydoor

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/** Definições globais (aplicam-se a todas as moradas). */
class GlobalSettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_global_settings)
        val prefs = Prefs(this)

        val etSpeed = findViewById<EditText>(R.id.etSpeed)
        val etCooldown = findViewById<EditText>(R.id.etCooldown)
        val etPauseMin = findViewById<EditText>(R.id.etPauseMin)
        val cbAutoPause = findViewById<CheckBox>(R.id.cbAutoPause)
        val etGrace = findViewById<EditText>(R.id.etNetGrace)
        val etAuthKeyGlobal = findViewById<EditText>(R.id.etAuthKeyGlobal)
        val etRearm = findViewById<EditText>(R.id.etRearmMargin)
        val etMinAcc = findViewById<EditText>(R.id.etMinAccuracy)
        val etNearInt = findViewById<EditText>(R.id.etNearInterval)
        val etFarInt = findViewById<EditText>(R.id.etFarInterval)
        val cbActive = findViewById<CheckBox>(R.id.cbActiveTracking)
        val cbWifiArmed = findViewById<CheckBox>(R.id.cbWifiBlocksArmed)

        etSpeed.setText(prefs.maxSpeedMs.toString())
        etCooldown.setText((prefs.cooldownMs / 1000).toString())
        etPauseMin.setText(prefs.pauseMinutes.toString())
        cbAutoPause.isChecked = prefs.autoPauseAfterOpen
        etGrace.setText(prefs.networkGraceSeconds.toString())
        etAuthKeyGlobal.setText(prefs.cloudAuthKeyGlobal)
        etRearm.setText(prefs.rearmMarginM.toString())
        etMinAcc.setText(prefs.minAccuracyM.toString())
        etNearInt.setText(prefs.nearIntervalSec.toString())
        etFarInt.setText(prefs.farIntervalSec.toString())
        cbActive.isChecked = prefs.activeTracking
        cbWifiArmed.isChecked = prefs.wifiBlocksWhenArmed

        findViewById<Button>(R.id.btnBattery).setOnClickListener { askIgnoreBatteryOptimizations() }

        findViewById<Button>(R.id.btnRearmNow).setOnClickListener {
            val store = DoorStore(this)
            val doors = store.all()
            doors.forEach { d ->
                d.armed = true
                d.lastArmedAt = System.currentTimeMillis()
                d.lastOpenAt = 0L
                d.pauseUntil = 0L
                d.lastReason = "Armada à mão ✓"
            }
            store.updateAll(doors)
            prefs.clearPause()
            Toast.makeText(this, "${doors.size} morada(s) armadas — a próxima chegada abre", Toast.LENGTH_LONG).show()
        }

        findViewById<Button>(R.id.btnSaveGlobal).setOnClickListener {
            prefs.maxSpeedMs = etSpeed.text.toString().toFloatOrNull() ?: prefs.maxSpeedMs
            prefs.cooldownMs = (etCooldown.text.toString().toLongOrNull() ?: 30) * 1000
            prefs.pauseMinutes = etPauseMin.text.toString().toIntOrNull() ?: 10
            prefs.autoPauseAfterOpen = cbAutoPause.isChecked
            prefs.networkGraceSeconds = etGrace.text.toString().toIntOrNull() ?: 60
            prefs.cloudAuthKeyGlobal = etAuthKeyGlobal.text.toString().trim()
            prefs.rearmMarginM = etRearm.text.toString().toFloatOrNull() ?: prefs.rearmMarginM
            prefs.minAccuracyM = etMinAcc.text.toString().toFloatOrNull() ?: prefs.minAccuracyM
            prefs.nearIntervalSec = (etNearInt.text.toString().toIntOrNull() ?: 4).coerceIn(1, 60)
            prefs.farIntervalSec = (etFarInt.text.toString().toIntOrNull() ?: 45).coerceIn(5, 600)
            prefs.activeTracking = cbActive.isChecked
            prefs.wifiBlocksWhenArmed = cbWifiArmed.isChecked

            // Reiniciar o serviço para aplicar os novos ritmos de GPS.
            stopService(Intent(this, DoorService::class.java))
            DoorServiceStarter.ensureRunning(this)
            finish()
        }
    }

    private fun askIgnoreBatteryOptimizations() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "Já está isenta da otimização de bateria ✓", Toast.LENGTH_LONG).show()
            return
        }
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (e2: Exception) {
                Toast.makeText(this, "Abre à mão: Definições → Apps → ShellyDoor → Bateria → Sem restrições", Toast.LENGTH_LONG).show()
            }
        }
    }
}
