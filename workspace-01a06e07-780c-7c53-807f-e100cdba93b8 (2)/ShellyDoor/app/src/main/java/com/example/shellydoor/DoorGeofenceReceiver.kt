package com.example.shellydoor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/**
 * Recebe os eventos de geofence em background (mesmo com o ecrã bloqueado).
 * Identifica a morada responsável pelo evento e aplica a decisão para essa porta.
 */
class DoorGeofenceReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val geofencingEvent = GeofencingEvent.fromIntent(intent) ?: return
        if (geofencingEvent.hasError()) {
            Log.e(TAG, "Erro geofence: ${geofencingEvent.errorCode}")
            return
        }

        val prefs = Prefs(context)
        val store = DoorStore(context)
        val wifi = WifiHomeChecker(context, prefs, store)
        val engine = DoorDecisionEngine(prefs, wifi)

        val speed = geofencingEvent.getTriggeringLocation()?.speed ?: 0f

        // O método correto é getGeofenceTransition() (não getTransition()).
        // Usamos getters explícitos + métodos, para não depender de propriedades
        // Kotlin que podem não ser geradas dependendo da versão do SDK.
        val transition = geofencingEvent.getGeofenceTransition()
        val isEnter = transition == Geofence.GEOFENCE_TRANSITION_ENTER
        val isExit = transition == Geofence.GEOFENCE_TRANSITION_EXIT
        // Ignora eventos que não sejam de entrada/saída
        if (!isEnter && !isExit) return
        val entered = isEnter

        // Descobrir a porta que disparou através do requestId do geofence
        val doorId = geofencingEvent.getTriggeringGeofences()?.firstOrNull()?.requestId
        val door = doorId?.let { store.byId(it) }
        if (door == null) {
            Log.w(TAG, "Evento sem porta correspondente (id=$doorId)")
            return
        }

        val outcome = engine.evaluate(door, entered, speed)
        when (outcome) {
            is DoorDecisionEngine.Outcome.AllowOpen -> {
                Log.i(TAG, "Decisão: abrir ${door.name}")
                Notifier.showOpenNotification(context, door, "A carregar…")
                ShellyController(prefs).openDoor(door) { ok, msg ->
                    prefs.lastResult = msg
                    if (ok) {
                        Notifier.updateOpenNotification(context, door, "Porta aberta ✓")
                        if (prefs.autoPauseAfterOpen) {
                            prefs.applyPause(prefs.pauseMinutes)
                            Notifier.showManualNotification(
                                context, door,
                                "Porta aberta ✓ — automação em pausa ${prefs.pauseMinutes} min"
                            )
                        }
                    } else {
                        Notifier.showOpenNotification(context, door, "Não consegui abrir: $msg")
                    }
                }
            }
            is DoorDecisionEngine.Outcome.Denied -> {
                Log.i(TAG, "Decisão: NÃO abrir (${door.name}): ${outcome.reason}")
                prefs.lastResult = "Bloqueado (${door.name}): ${outcome.reason}"
                Notifier.showManualNotification(context, door, "${door.name}: porta não abriu autom. (${outcome.reason})")
            }
        }
    }

    companion object {
        private const val TAG = "DoorGeofenceReceiver"
    }
}
