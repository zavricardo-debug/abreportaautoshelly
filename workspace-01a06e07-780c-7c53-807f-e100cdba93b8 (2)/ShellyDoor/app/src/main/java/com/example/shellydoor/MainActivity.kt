package com.example.shellydoor

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Ecrã principal: lista as moradas (cada uma independente, com a sua porta e Shelly).
 *
 * Também é aqui que se pedem as permissões. Isto FALTAVA por completo: a app
 * nunca pedia localização nem notificações, por isso em muitos telemóveis o
 * serviço nem sequer arrancava e a porta nunca abria sozinha.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var store: DoorStore
    private lateinit var tvStatus: TextView
    private lateinit var doorList: LinearLayout

    /** Permissões base: localização (fina) + notificações no Android 13+. */
    private val basePerms: Array<String>
        get() {
            val list = mutableListOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                list.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            return list.toTypedArray()
        }

    private val basePermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (hasFineLocation()) {
                askBackgroundLocation()
                DoorServiceStarter.ensureRunning(this)
            } else {
                toast("Sem localização a app não consegue abrir a porta sozinha.")
            }
            rebuild()
        }

    private val bgPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            DoorServiceStarter.ensureRunning(this)
            rebuild()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.setBackgroundDrawableResource(R.color.background)
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
            if (prefs.autoEnabled) ensurePermissionsAndStart() else disableAuto()
            rebuild()
        }
        findViewById<Button>(R.id.btnPause).setOnClickListener { togglePause() }
        findViewById<Button>(R.id.btnSettings).setOnClickListener {
            startActivity(Intent(this, GlobalSettingsActivity::class.java))
        }

        ensurePermissionsAndStart()
    }

    override fun onResume() {
        super.onResume()
        if (prefs.autoEnabled && hasFineLocation()) DoorServiceStarter.ensureRunning(this)
        rebuild()
    }

    // ------------------------------------------------------------------
    // Permissões
    // ------------------------------------------------------------------

    private fun hasFineLocation() = ContextCompat.checkSelfPermission(
        this, Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    private fun hasBackgroundLocation(): Boolean =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) true
        else ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_BACKGROUND_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

    private fun ensurePermissionsAndStart() {
        val missing = basePerms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            basePermLauncher.launch(missing.toTypedArray())
            return
        }
        askBackgroundLocation()
        if (prefs.autoEnabled) DoorServiceStarter.ensureRunning(this)
    }

    /**
     * A localização "sempre" tem de ser pedida em separado (o Android obriga) e é
     * ela que permite abrir a porta com a app fechada e o ecrã desligado.
     */
    private fun askBackgroundLocation() {
        if (hasBackgroundLocation()) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        AlertDialog.Builder(this)
            .setTitle("Permitir localização “Sempre”")
            .setMessage(
                "Para a porta abrir com a app fechada e o ecrã bloqueado, o Android " +
                        "exige a localização definida como “Permitir sempre”.\n\n" +
                        "No ecrã seguinte escolhe “Permitir sempre”."
            )
            .setPositiveButton("Continuar") { _, _ ->
                bgPermLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            }
            .setNegativeButton("Agora não", null)
            .show()
    }

    /** A otimização de bateria é a causa nº1 de "às vezes abre, às vezes não". */
    private fun askIgnoreBatteryOptimizations() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            toast("A app já está isenta da otimização de bateria ✓")
            return
        }
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

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
        val pause = if (prefs.isPaused())
            "\n⏸ Em pausa (${prefs.pauseRemainingMillis() / 60000} min)" else ""

        val warnings = buildList {
            if (!hasFineLocation()) add("⚠ Falta a permissão de localização — toca aqui")
            else if (!hasBackgroundLocation()) add("⚠ Localização não está em “Sempre” — não abre com a app fechada")
            if (doors.any { it.enabled && !it.hasPoint() })
                add("⚠ Há moradas sem ponto definido")
        }.joinToString("\n")

        tvStatus.text = buildString {
            append(if (prefs.autoEnabled) "Automação LIGADA ($n morada(s))" else "Automação desligada")
            append(pause)
            if (warnings.isNotEmpty()) append("\n").append(warnings)
            append("\n").append(prefs.lastResult)
        }
        tvStatus.setOnClickListener { ensurePermissionsAndStart() }
    }

    private fun buildRow(door: Door): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 14, 0, 14)
        }
        val name = TextView(this).apply {
            text = "🏠 ${door.name}" + (if (door.enabled) "" else "  (desativada)") +
                    (if (door.enabled && door.armed) "  🟢 armada" else "")
            textSize = 18f; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(
                ContextCompat.getColor(
                    this@MainActivity,
                    if (door.enabled && door.armed) R.color.success else R.color.text_primary
                )
            )
        }
        box.addView(name)

        val coords = TextView(this).apply {
            text = if (door.hasPoint())
                "ponto: (%.5f, %.5f) · raio %.0fm".format(door.lat, door.lng, door.radiusM)
            else "⚠ sem ponto definido"
            textSize = 13f; setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
        }
        box.addView(coords)

        // Diagnóstico: distância atual + último motivo. É o que te diz PORQUÊ
        // é que não abriu quando estavas à porta.
        if (door.lastSeenAt > 0L) {
            val diag = TextView(this).apply {
                val dist = if (door.lastDistanceM >= 0f) "a %.0f m · ".format(door.lastDistanceM) else ""
                text = "$dist${door.lastReason}"
                textSize = 12f; setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
            }
            box.addView(diag)
        }

        val btnRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        btnRow.addView(makeBtn("🔓 Abrir") { openDoor(door) })
        btnRow.addView(makeBtn("✏ Editar") { openEditor(door.id) })
        btnRow.addView(makeBtn("🗑 Apagar") { confirmDelete(door) })
        box.addView(btnRow)

        return box
    }

    private fun confirmDelete(door: Door) {
        AlertDialog.Builder(this)
            .setTitle("Remover ${door.name}?")
            .setPositiveButton("Remover") { _, _ ->
                store.remove(door.id); reRegisterAndRebuild()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun makeBtn(text: String, click: () -> Unit): Button =
        Button(this).apply { this.text = text; setOnClickListener { click() } }

    private fun openEditor(doorId: String) {
        startActivity(
            Intent(this, DoorSettingsActivity::class.java)
                .putExtra(DoorSettingsActivity.EXTRA_DOOR_ID, doorId)
        )
    }

    private fun openDoor(door: Door) {
        statusRow("${door.name}: a abrir manualmente…")
        ShellyController(prefs).openDoor(door) { ok, msg ->
            if (ok) {
                store.byId(door.id)?.let { d ->
                    d.armed = false
                    d.lastOpenAt = System.currentTimeMillis()
                    d.lastReason = "Aberta à mão ✓"
                    store.update(d)
                }
            }
            runOnUiThread {
                statusRow(if (ok) "${door.name}: porta aberta ✓" else "${door.name}: $msg")
            }
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
    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    /** Chamado pelo menu de definições globais para o atalho da bateria. */
    fun openBatterySettings() = askIgnoreBatteryOptimizations()
}
