package com.example.shellydoor

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.location.Location
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Ecrã "Porque é que não abre?" — diagnóstico AO VIVO de uma morada.
 *
 * Mostra, atualizado a cada segundo enquanto estás no local:
 *  - a distância à porta, a precisão do GPS e a velocidade;
 *  - a lista de TODAS as condições, com ✅ as cumpridas e ❌ as que faltam;
 *  - o que falta exatamente para a porta abrir, e como resolver.
 *
 * Ao contrário do motor de decisão (que pára na primeira condição falhada),
 * aqui vê-se o quadro completo — que é o que faz falta para perceber, no
 * ponto de disparo, o que está a impedir a abertura.
 */
class DoorDiagnosticsActivity : AppCompatActivity() {

    private lateinit var store: DoorStore
    private lateinit var prefs: Prefs
    private lateinit var engine: DoorDecisionEngine
    private var doorId: String? = null

    private lateinit var root: LinearLayout
    private lateinit var tvHeader: TextView
    private lateinit var tvVerdict: TextView
    private lateinit var tvNumbers: TextView
    private lateinit var listBox: LinearLayout
    private lateinit var tvFooter: TextView

    private val handler = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null

    private var fusedCallback: LocationCallback? = null
    private var lastLocation: Location? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Porque é que não abre?"

        store = DoorStore(this)
        prefs = Prefs(this)
        engine = DoorDecisionEngine(prefs, WifiHomeChecker(this, prefs, store))
        doorId = intent.getStringExtra(EXTRA_DOOR_ID)

        buildUi()

        if (store.byId(doorId ?: "") == null) {
            Toast.makeText(this, "Morada não encontrada.", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
            setBackgroundColor(color(R.color.background))
        }

        tvHeader = TextView(this).apply {
            textSize = 20f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(color(R.color.text_primary))
        }
        root.addView(tvHeader)

        tvVerdict = TextView(this).apply {
            textSize = 16f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setPadding(0, dp(10), 0, dp(6))
        }
        root.addView(tvVerdict)

        tvNumbers = TextView(this).apply {
            textSize = 13f
            setTextColor(color(R.color.text_secondary))
            setPadding(0, 0, 0, dp(10))
        }
        root.addView(tvNumbers)

        listBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
            addView(listBox)
        }
        root.addView(scroll)

        tvFooter = TextView(this).apply {
            textSize = 11.5f
            setTextColor(color(R.color.text_hint))
            setPadding(0, dp(8), 0, dp(8))
            gravity = Gravity.CENTER
        }
        root.addView(tvFooter)

        root.addView(Button(this).apply {
            text = "🔓 Abrir esta porta agora (teste do Shelly)"
            setOnClickListener { testOpen() }
        })

        root.addView(Button(this).apply {
            text = "🔄 Armar esta morada agora"
            setOnClickListener { armNow() }
        })

        // Atalhos directos para os campos que se ajustam a partir daqui.
        // Sem isto, quem esta no local nao sabe onde mudar os 55 m / 60 s.
        root.addView(TextView(this).apply {
            text = "AJUSTAR OS VALORES"
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
            setTextColor(color(R.color.text_hint))
            setPadding(0, dp(14), 0, dp(4))
        })

        root.addView(Button(this).apply {
            text = "⚙️ Afastamento e tempo p/ armar (55 m · 60 s)"
            setOnClickListener {
                startActivity(Intent(this@DoorDiagnosticsActivity, GlobalSettingsActivity::class.java))
            }
        })
        root.addView(TextView(this).apply {
            text = "Secção \"Aproximação\": \"Margem de rearme (metros)\" e " +
                "\"Tempo longe para armar (segundos)\"."
            textSize = 11.5f
            setTextColor(color(R.color.text_hint))
            setPadding(dp(4), 0, 0, dp(6))
        })

        root.addView(Button(this).apply {
            text = "📍 Raio de disparo desta morada"
            setOnClickListener {
                startActivity(
                    Intent(this@DoorDiagnosticsActivity, DoorSettingsActivity::class.java)
                        .putExtra(DoorSettingsActivity.EXTRA_DOOR_ID, doorId)
                )
            }
        })
        root.addView(TextView(this).apply {
            text = "Campo \"Raio de disparo (metros)\". O afastamento para armar " +
                "é este raio + a margem de rearme."
            textSize = 11.5f
            setTextColor(color(R.color.text_hint))
            setPadding(dp(4), 0, 0, dp(6))
        })

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        startLiveLocation()
        ticker = object : Runnable {
            override fun run() {
                refresh()
                handler.postDelayed(this, 1000L)
            }
        }.also { handler.post(it) }
    }

    override fun onPause() {
        super.onPause()
        ticker?.let { handler.removeCallbacks(it) }
        ticker = null
        stopLiveLocation()
    }

    /**
     * Pede posições rápidas enquanto este ecrã está aberto, para os números
     * se mexerem em tempo real enquanto andas à volta do ponto de disparo.
     */
    @SuppressLint("MissingPermission")
    private fun startLiveLocation() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L)
            .setMinUpdateIntervalMillis(500L)
            .setWaitForAccurateLocation(false)
            .build()

        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { lastLocation = it }
            }
        }
        runCatching {
            LocationServices.getFusedLocationProviderClient(this)
                .requestLocationUpdates(req, cb, Looper.getMainLooper())
            fusedCallback = cb
        }
    }

    private fun stopLiveLocation() {
        fusedCallback?.let {
            runCatching {
                LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(it)
            }
        }
        fusedCallback = null
    }

    private fun refresh() {
        val door = store.byId(doorId ?: "") ?: return
        tvHeader.text = "🏠 ${door.name}"

        val loc = lastLocation
        val diag: Diagnostics? = if (loc != null && door.hasPoint()) {
            // Avalia com a posição LIVE deste ecrã (não muta a morada).
            engine.diagnose(
                door,
                DoorDecisionEngine.distanceTo(door, loc),
                if (loc.hasAccuracy()) loc.accuracy else -1f,
                if (loc.hasSpeed()) loc.speed else -1f,
                "ecrã"
            )
        } else {
            // Sem GPS ainda: mostra o último retrato gravado pelo serviço.
            Diagnostics.fromJsonOrNull(door.lastDiagnostics)
        }

        if (diag == null) {
            tvVerdict.text = "À espera do GPS…"
            tvVerdict.setTextColor(color(R.color.text_secondary))
            tvNumbers.text = if (!door.hasPoint())
                "Esta morada ainda não tem o ponto da porta definido."
            else "Sai para um sítio com céu à vista para apanhar sinal."
            listBox.removeAllViews()
            return
        }

        tvVerdict.text = if (diag.wouldOpen) "✅ ${diag.verdict}" else "❌ ${diag.verdict}"
        tvVerdict.setTextColor(color(if (diag.wouldOpen) R.color.success else R.color.danger))

        val age = if (loc == null && diag.at > 0L)
            "  ·  há ${(System.currentTimeMillis() - diag.at) / 1000}s" else ""
        tvNumbers.text = buildString {
            append("distância %.0f m".format(diag.distanceM))
            append("  ·  raio %.0f m".format(door.radiusM))
            if (diag.accuracyM > 0) append("  ·  GPS ±%.0f m".format(diag.accuracyM))
            if (diag.speedMs >= 0) append("  ·  %.1f m/s".format(diag.speedMs))
            append(age)
        }

        renderConditions(diag)

        tvFooter.text = "Atualiza a cada segundo  ·  " +
                SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
    }

    private fun renderConditions(diag: Diagnostics) {
        listBox.removeAllViews()

        // Primeiro o que FALTA, depois o que já está OK — o que interessa fica
        // logo à vista, sem ter de procurar na lista.
        val ordered = diag.conditions.sortedBy {
            when (it.state) {
                Condition.State.BLOCKED -> 0
                Condition.State.UNKNOWN -> 1
                Condition.State.OK -> 2
                Condition.State.NOT_APPLICABLE -> 3
            }
        }

        var headerShown = false
        var okHeaderShown = false

        ordered.forEach { cond ->
            if (!headerShown && cond.state == Condition.State.BLOCKED) {
                listBox.addView(sectionLabel("A FALTAR"))
                headerShown = true
            }
            if (!okHeaderShown && cond.state != Condition.State.BLOCKED) {
                listBox.addView(sectionLabel("JÁ CUMPRIDO"))
                okHeaderShown = true
            }
            listBox.addView(conditionRow(cond))
        }
    }

    private fun sectionLabel(text: String) = TextView(this).apply {
        this.text = text
        textSize = 12f
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        setTextColor(color(R.color.primary))
        setPadding(0, dp(14), 0, dp(4))
    }

    private fun conditionRow(c: Condition): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(6), 0, dp(6))
        }

        box.addView(TextView(this).apply {
            text = "${c.icon}  ${c.name}"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(
                color(
                    when (c.state) {
                        Condition.State.BLOCKED -> R.color.danger
                        Condition.State.OK -> R.color.success
                        else -> R.color.text_secondary
                    }
                )
            )
        })

        box.addView(TextView(this).apply {
            text = "agora: ${c.actual}\nprecisa: ${c.needed}"
            textSize = 13f
            setTextColor(color(R.color.text_primary))
            setPadding(dp(26), 0, 0, 0)
        })

        if (c.state == Condition.State.BLOCKED && c.hint.isNotBlank()) {
            box.addView(TextView(this).apply {
                text = "→ ${c.hint}"
                textSize = 12.5f
                setTextColor(color(R.color.text_secondary))
                setPadding(dp(26), dp(2), 0, 0)
            })
        }

        return box
    }

    private fun armNow() {
        val door = store.byId(doorId ?: "") ?: return
        engine.forceArm(door)
        store.update(door)
        DoorServiceStarter.ensureRunning(this)
        Toast.makeText(this, "${door.name} armada ✓ — aproxima-te da porta", Toast.LENGTH_LONG).show()
        refresh()
    }

    private fun testOpen() {
        val door = store.byId(doorId ?: "") ?: return
        Toast.makeText(this, "A enviar impulso…", Toast.LENGTH_SHORT).show()
        ShellyController(prefs).openDoor(door) { ok, msg ->
            runOnUiThread {
                Toast.makeText(
                    this,
                    if (ok) "Shelly OK ✓ — a porta deve ter aberto" else "Falhou: $msg",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_DOOR_ID = "door_id"
    }
}
