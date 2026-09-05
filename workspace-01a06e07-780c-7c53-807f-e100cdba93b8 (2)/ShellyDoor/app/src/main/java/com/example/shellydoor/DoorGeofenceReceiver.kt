package com.example.shellydoor

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import com.google.android.gms.location.LocationServices

/**
 * Rede de segurança: eventos de geofence do sistema.
 *
 * O caminho principal é o rastreio ativo do [DoorService]; este recetor existe
 * porque o sistema pode adormecer o serviço. Em vez de decidir por si, pede uma
 * posição atual e delega no [ApproachEvaluator] — a mesma lógica dos dois lados.
 */
class DoorGeofenceReceiver : BroadcastReceiver() {

    @SuppressLint("MissingPermission")
    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) {
            Log.e(TAG, "Erro geofence: ${event.errorCode}")
            return
        }

        val transition = event.geofenceTransition
        val relevant = transition == Geofence.GEOFENCE_TRANSITION_ENTER ||
                transition == Geofence.GEOFENCE_TRANSITION_DWELL ||
                transition == Geofence.GEOFENCE_TRANSITION_EXIT
        if (!relevant) return

        Log.i(TAG, "Geofence: transição=$transition ids=${event.triggeringGeofences?.map { it.requestId }}")

        // Garantir que o serviço (rastreio rápido) está a correr — é ele que
        // fecha o assunto com precisão.
        DoorServiceStarter.ensureRunning(context.applicationContext)

        val app = context.applicationContext
        val pending = goAsync()

        val triggering = event.triggeringLocation
        if (triggering != null) {
            try {
                ApproachEvaluator.evaluate(app, triggering, "geofence")
            } finally {
                pending.finish()
            }
            return
        }

        // Sem localização no evento: pede uma fresca ao Fused Provider.
        try {
            LocationServices.getFusedLocationProviderClient(app).lastLocation
                .addOnSuccessListener { loc ->
                    try {
                        if (loc != null) ApproachEvaluator.evaluate(app, loc, "geofence-last")
                        else Log.w(TAG, "Geofence sem localização disponível")
                    } finally {
                        pending.finish()
                    }
                }
                .addOnFailureListener {
                    Log.e(TAG, "Falha a obter localização: ${it.message}")
                    pending.finish()
                }
        } catch (e: Exception) {
            Log.e(TAG, "Erro no geofence: ${e.message}", e)
            pending.finish()
        }
    }

    companion object {
        private const val TAG = "DoorGeofenceReceiver"
    }
}
