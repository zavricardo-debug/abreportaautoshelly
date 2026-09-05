package com.example.shellydoor

import android.content.Context
import android.location.Location
import android.util.Log

/**
 * Ponto ÚNICO de avaliação de uma posição contra todas as moradas.
 *
 * É usado por dois caminhos, que se complementam:
 *  - [DoorService] — rastreio ativo (rápido e fiável à chegada);
 *  - [DoorGeofenceReceiver] — geofences do sistema (rede de segurança quando o
 *    telemóvel poupa bateria e o rastreio abranda).
 *
 * Ambos acabam aqui, por isso a lógica de decisão é exatamente a mesma e não há
 * risco de os dois caminhos discordarem.
 */
object ApproachEvaluator {

    private const val TAG = "ApproachEvaluator"

    /**
     * Avalia `location` contra todas as moradas e abre as que devem abrir.
     * @return a menor distância a uma morada ativa (para ajustar o ritmo do GPS),
     *         ou Float.MAX_VALUE se não houver moradas utilizáveis.
     */
    fun evaluate(context: Context, location: Location, source: String): Float {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val store = DoorStore(app)
        val wifi = WifiHomeChecker(app, prefs, store)
        val engine = DoorDecisionEngine(prefs, wifi)

        val doors = store.all()
        if (doors.isEmpty()) return Float.MAX_VALUE

        var nearest = Float.MAX_VALUE
        val toOpen = ArrayList<Door>()
        val toWarn = ArrayList<Pair<Door, String>>()

        // --- 1ª passagem: decidir (só muta objetos em memória) ---
        doors.forEach { door ->
            if (!door.enabled || !door.hasPoint()) return@forEach

            val distance = DoorDecisionEngine.distanceTo(door, location)
            if (distance < nearest) nearest = distance

            val accuracy = if (location.hasAccuracy()) location.accuracy else -1f
            val speed = if (location.hasSpeed()) location.speed else -1f

            // Retrato completo ANTES de decidir: mostra todas as condições, as
            // cumpridas e as que faltam, para o ecrã de diagnóstico.
            door.lastDiagnostics =
                engine.diagnose(door, distance, accuracy, speed, source).toJson().toString()

            when (val outcome = engine.evaluate(door, distance, accuracy, speed)) {
                is DoorDecisionEngine.Outcome.AllowOpen -> {
                    Log.i(TAG, "[$source] ABRIR ${door.name} (a %.0f m)".format(distance))
                    // Desarma + marca o cooldown JÁ, para que dois fixes seguidos
                    // (ou o geofence e o rastreio ao mesmo tempo) não disparem duas vezes.
                    engine.markOpened(door)
                    toOpen.add(door)
                }
                is DoorDecisionEngine.Outcome.Denied -> {
                    Log.i(TAG, "[$source] ${door.name}: ${outcome.reason}")
                    toWarn.add(door to outcome.reason)
                }
                is DoorDecisionEngine.Outcome.Silent -> {
                    Log.d(TAG, "[$source] ${door.name}: ${outcome.reason}")
                }
            }
        }

        // --- 2ª: gravar TODO o estado de uma vez, ANTES de qualquer rede ---
        // (assim os callbacks assíncronos, mais abaixo, nunca são sobrescritos)
        store.updateAll(doors)

        // --- 3ª: efeitos (rede + notificações) ---
        toOpen.forEach { door ->
            Notifier.showOpenNotification(app, door, "A chegar — a abrir…")
            ShellyController(prefs).openDoor(door) { ok, msg ->
                store.byId(door.id)?.let { d ->
                    d.lastReason = if (ok) "Aberta ✓" else "Falhou: $msg"
                    // Falhou? Limpa o cooldown para poder tentar outra vez já a seguir.
                    if (!ok) {
                        d.lastOpenAt = 0L
                        d.armed = true
                    }
                    store.update(d)
                }
                prefs.lastResult = if (ok) "${door.name}: porta aberta ✓" else "${door.name}: $msg"
                Notifier.updateOpenNotification(
                    app, door, if (ok) "Porta aberta ✓" else "Não consegui abrir: $msg"
                )
            }
        }

        toWarn.forEach { (door, reason) ->
            prefs.lastResult = "${door.name}: $reason"
            // Estavas à porta e não abriu: dá o botão manual para resolveres já.
            // Com throttle — o rastreio corre de 4 em 4 s e sem isto encheria a
            // barra de notificações enquanto estivesses perto.
            if (shouldWarn(door.id)) {
                Notifier.showManualNotification(app, door, "${door.name}: não abri automaticamente")
            }
        }

        return nearest
    }

    /** Uma notificação de aviso por morada, no máximo a cada [WARN_THROTTLE_MS]. */
    private val lastWarnAt = HashMap<String, Long>()

    @Synchronized
    private fun shouldWarn(doorId: String): Boolean {
        val now = System.currentTimeMillis()
        val prev = lastWarnAt[doorId] ?: 0L
        if (now - prev < WARN_THROTTLE_MS) return false
        lastWarnAt[doorId] = now
        return true
    }

    private const val WARN_THROTTLE_MS = 120_000L
}
