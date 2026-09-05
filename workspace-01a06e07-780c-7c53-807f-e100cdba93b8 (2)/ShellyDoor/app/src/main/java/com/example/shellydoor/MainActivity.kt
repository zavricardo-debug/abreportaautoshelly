package com.example.shellydoor

import android.content.Intent
import android.os.Bundle
import android.graphics.Typeface
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Ecrã principal: lista as moradas (cada uma independente, com a sua porta e Shelly).
 *  - "+ Adicionar morada" → cria uma nova e abre o seu ecrã de configuração.
 *  - Cada morada tem os seus botões "Abrir", "Editar" e "Apagar".
 *  - ⚙ Globais (velocidade, cooldown, pausa) e ⏸ Pausa.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var store: DoorStore
    private lateinit var tvStatus: TextView
    private lateinit var doorList: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        store = DoorStore(this)
        tvStatus = findViewById(R.id.tvStatus)
        doorList = findViewById(R.id.doorList)

        findViewById<Button>(R.id.btnAddDoor).setOnClickListener {
            val door = store.newDoor()
            openEditor(door.id)
        }
        findViewById<Button>(R.id.btnToggleAuto).setOnClickListener {
            prefs.autoEnabled = !prefs.autoEnabled
            if (prefs.autoEnabled) DoorServiceStarter.ensureRunning(this) else disableAuto()
            rebuild()
        }
        findViewById<Button>(R.id.btnPause).setOnClickListener { togglePause() }
        findViewById<Button>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, GlobalSettingsActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        rebuild()
    }

    private fun rebuild() {
        doorList.removeAllViews()
        val doors = store.all()
        if (doors.isEmpty()) {
            val empty = TextView(this).apply {
                text = "Ainda não tens moradas. Toca em + para adicionar a primeira."
                textSize = 14f; setPadding(0, 20, 0, 20)
            }
            doorList.addView(empty)
        } else {
            doors.forEach { door -> doorList.addView(buildRow(door)) }
        }
        val n = doors.count { it.enabled && it.hasPoint() }
        val pause = if (prefs.isPaused()) "\n⏸ Em pausa (${prefs.pauseRemainingMillis() / 60000} min)" else ""
        tvStatus.text =
            (if (prefs.autoEnabled) "Automação LIGADA ($n morada(s))" else "Automação desligada") +
                    pause + "\n${prefs.lastResult}"
    }

    private fun buildRow(door: Door): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 14, 0, 14)
        }
        val name = TextView(this).apply {
            text = "🏠 ${door.name}" + (if (door.enabled) "" else "  (desativada)")
            textSize = 18f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        box.addView(name)

        val coords = TextView(this).apply {
            text = if (door.hasPoint())
                "ponto: (%.5f, %.5f) · raio %.0fm".format(door.lat, door.lng, door.radiusM)
            else "⚠ sem ponto definido"
            textSize = 13f; setTextColor(0xFF666666.toInt())
        }
        box.addView(coords)

        val btnRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        btnRow.addView(makeBtn("🔓 Abrir") { openDoor(door) })
        btnRow.addView(makeBtn("✏ Editar") { openEditor(door.id) })
        btnRow.addView(makeBtn("🗑 Apagar") { store.remove(door.id); reRegisterAndRebuild() })
        box.addView(btnRow)

        return box
    }

    private fun makeBtn(text: String, click: () -> Unit): Button {
        val b = Button(this).apply { this.text = text; setOnClickListener { click() } }
        return b
    }

    private fun openEditor(doorId: String) {
        startActivity(Intent(this, DoorSettingsActivity::class.java).putExtra(DoorSettingsActivity.EXTRA_DOOR_ID, doorId))
    }

    private fun openDoor(door: Door) {
        statusRow("${door.name}: a abrir manualmente…")
        ShellyController(prefs).openDoor(door) { ok, msg ->
            runOnUiThread { statusRow(if (ok) "${door.name}: porta aberta ✓" else "${door.name}: $msg") }
        }
    }

    private fun togglePause() {
        if (prefs.isPaused()) {
            prefs.clearPause(); statusRow("⏸ Pausa cancelada — automação reativada")
        } else {
            prefs.applyPause(prefs.pauseMinutes)
            statusRow("⏸ Em pausa ${prefs.pauseMinutes} min (botão manual continua a funcionar)")
        }
        rebuild()
    }

    private fun reRegisterAndRebuild() {
        DoorServiceStarter.ensureRunning(this)
        rebuild()
    }

    private fun disableAuto() { stopService(Intent(this, DoorService::class.java)) }
    private fun statusRow(s: String) { tvStatus.text = s }
}
