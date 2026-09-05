package com.example.shellydoor

import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity

/** Definições globais (aplicam-se a todas as moradas): velocidade, cooldown, pausa, auth key. */
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

        etSpeed.setText(prefs.maxSpeedMs.toString())
        etCooldown.setText((prefs.cooldownMs / 1000).toString())
        etPauseMin.setText(prefs.pauseMinutes.toString())
        cbAutoPause.isChecked = prefs.autoPauseAfterOpen
        etGrace.setText(prefs.networkGraceSeconds.toString())
        etAuthKeyGlobal.setText(prefs.cloudAuthKeyGlobal)

        findViewById<Button>(R.id.btnSaveGlobal).setOnClickListener {
            prefs.maxSpeedMs = etSpeed.text.toString().toFloatOrNull() ?: prefs.maxSpeedMs
            prefs.cooldownMs = (etCooldown.text.toString().toLongOrNull() ?: 30) * 1000
            prefs.pauseMinutes = etPauseMin.text.toString().toIntOrNull() ?: 10
            prefs.autoPauseAfterOpen = cbAutoPause.isChecked
            prefs.networkGraceSeconds = etGrace.text.toString().toIntOrNull() ?: 60
            prefs.cloudAuthKeyGlobal = etAuthKeyGlobal.text.toString()
            finish()
        }
    }
}
