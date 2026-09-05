package com.example.shellydoor

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Switch
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices

/**
 * Configuração de UMA morada: nome, ponto (GPS/mapa/manual), raio,
 * Wi-Fi de casa (kill-switch) e o Shelly próprio desta porta.
 */
class DoorSettingsActivity : AppCompatActivity() {

    private lateinit var store: DoorStore
    private var doorId: String? = null

    private val permLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted.values.all { it }) setPointByGps() else toast("Dá a permissão de localização para usar o GPS.")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_door_settings)
        store = DoorStore(this)
        doorId = intent.getStringExtra(EXTRA_DOOR_ID)
        val door = doorId?.let { store.byId(it) }
        if (door == null) {
            toast("Morada não encontrada."); finish(); return
        }

        findViewById<EditText>(R.id.etName).setText(door.name)
        findViewById<Switch>(R.id.swEnabled).isChecked = door.enabled
        findViewById<EditText>(R.id.etRadius).setText(door.radiusM.toString())
        findViewById<EditText>(R.id.etLat).setText(if (door.hasPoint()) door.lat.toString() else "")
        findViewById<EditText>(R.id.etLng).setText(if (door.hasPoint()) door.lng.toString() else "")
        findViewById<EditText>(R.id.etHomeSsid).setText(door.homeSsid)
        findViewById<CheckBox>(R.id.cbWifiKill).isChecked = door.wifiKillEnabled
        findViewById<EditText>(R.id.etMode).setText(door.controlMode)
        findViewById<EditText>(R.id.etChannel).setText(door.channel.toString())
        findViewById<EditText>(R.id.etIp).setText(door.shellIp)
        findViewById<EditText>(R.id.etCloudHost).setText(door.cloudHost)
        findViewById<EditText>(R.id.etDeviceId).setText(door.cloudDeviceId)
        findViewById<EditText>(R.id.etAuthKey).setText(door.cloudAuthKey)
        findViewById<EditText>(R.id.etPulse).setText(door.relayPulseSeconds.toString())

        findViewById<Button>(R.id.btnGpsPoint).setOnClickListener { askGpsAndSet(door) }
        findViewById<Button>(R.id.btnMapPoint).setOnClickListener {
            startActivity(Intent(this, MapsActivity::class.java).putExtra(MapsActivity.EXTRA_DOOR_ID, door.id))
        }
        findViewById<Button>(R.id.btnSaveDoor).setOnClickListener {
            val d = store.byId(door.id) ?: return@setOnClickListener
            d.name = findViewById<EditText>(R.id.etName).text.toString().ifBlank { "Morada" }
            d.enabled = findViewById<Switch>(R.id.swEnabled).isChecked
            d.radiusM = findViewById<EditText>(R.id.etRadius).text.toString().toFloatOrNull() ?: d.radiusM
            findViewById<EditText>(R.id.etLat).text.toString().toDoubleOrNull()?.let { d.lat = it }
            findViewById<EditText>(R.id.etLng).text.toString().toDoubleOrNull()?.let { d.lng = it }
            d.homeSsid = findViewById<EditText>(R.id.etHomeSsid).text.toString()
            d.wifiKillEnabled = findViewById<CheckBox>(R.id.cbWifiKill).isChecked
            d.controlMode = findViewById<EditText>(R.id.etMode).text.toString().ifBlank { "cloud" }
            d.channel = findViewById<EditText>(R.id.etChannel).text.toString().toIntOrNull() ?: 0
            d.shellIp = findViewById<EditText>(R.id.etIp).text.toString()
            d.cloudHost = findViewById<EditText>(R.id.etCloudHost).text.toString()
            d.cloudDeviceId = findViewById<EditText>(R.id.etDeviceId).text.toString()
            d.cloudAuthKey = findViewById<EditText>(R.id.etAuthKey).text.toString()
            d.relayPulseSeconds = findViewById<EditText>(R.id.etPulse).text.toString().toIntOrNull() ?: 1
            store.update(d)
            DoorServiceStarter.ensureRunning(this)
            toast("Morada guardada ✓")
            finish()
        }
        findViewById<Button>(R.id.btnDeleteDoor).setOnClickListener {
            store.remove(door.id); DoorServiceStarter.ensureRunning(this)
            toast("Morada removida"); finish()
        }
    }

    override fun onResume() {
        super.onResume()
        // Se veio do mapa e escolheu um ponto, refletir nas caixas lat/lng
        val door = doorId?.let { store.byId(it) }
        if (door != null && door.hasPoint()) {
            findViewById<EditText>(R.id.etLat).setText(door.lat.toString())
            findViewById<EditText>(R.id.etLng).setText(door.lng.toString())
        }
    }

    private fun askGpsAndSet(door: Door) {
        val missing = listOf(Manifest.permission.ACCESS_FINE_LOCATION).filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) permLauncher.launch(missing.toTypedArray()) else setPointByGps()
    }

    private fun setPointByGps() {
        val door = doorId?.let { store.byId(it) } ?: return
        LocationServices.getFusedLocationProviderClient(this).lastLocation
            .addOnSuccessListener { loc ->
                if (loc != null) {
                    door.lat = loc.latitude; door.lng = loc.longitude
                    store.update(door)
                    findViewById<EditText>(R.id.etLat).setText(door.lat.toString())
                    findViewById<EditText>(R.id.etLng).setText(door.lng.toString())
                    toast("Ponto definido por GPS ✓")
                } else toast("Não consegui obter posição. Liga a localização.")
            }
            .addOnFailureListener { toast("Erro ao obter posição: ${it.message}") }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    companion object {
        const val EXTRA_DOOR_ID = "door_id"
    }
}
