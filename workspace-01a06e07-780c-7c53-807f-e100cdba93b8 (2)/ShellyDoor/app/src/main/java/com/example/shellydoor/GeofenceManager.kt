package com.example.shellydoor

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices

/**
 * Regista um geofence (círculo) para CADA morada ativa que tenha ponto definido.
 * Cada geofence usa como requestId o `id` da porta, para que o recetor consiga
 * saber "que morada" disparou.
 */
class GeofenceManager(private val context: Context) {

    private val client: GeofencingClient = LocationServices.getGeofencingClient(context)
    private val store = DoorStore(context)

    @SuppressLint("MissingPermission")
    fun registerAll() {
        val doors = store.all().filter { it.enabled && it.hasPoint() }
        if (doors.isEmpty()) {
            Log.w(TAG, "Sem portas ativas com ponto definido; não registo geofences.")
            unregister()
            return
        }

        // Remover tudo e voltar a adicionar (mais simples que atualizar subset)
        val request = GeofencingRequest.Builder()
            .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
        doors.forEach { door ->
            request.addGeofence(
                Geofence.Builder()
                    .setRequestId(door.id)
                    .setCircularRegion(door.lat, door.lng, door.radiusM)
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER)
                    .build()
            )
        }

        client.removeGeofences(pendingIntent()).addOnSuccessListener {
            client.addGeofences(request.build(), pendingIntent()).addOnSuccessListener {
                Log.i(TAG, "${doors.size} geofence(s) ativos: ${doors.map { it.name }}")
                Prefs(context).lastResult = "${doors.size} morada(s) ativa(s) ✓"
            }.addOnFailureListener {
                Log.e(TAG, "Falha ao adicionar geofences", it)
                Prefs(context).lastResult = "Falha geofence: ${it.message}"
            }
        }.addOnFailureListener {
            Log.e(TAG, "Falha ao remover geofences (a tentar adicionar mesmo assim)", it)
        }
    }

    fun unregister() {
        client.removeGeofences(pendingIntent())
        Log.i(TAG, "Geofences removidos")
    }

    private fun pendingIntent(): PendingIntent {
        val intent = Intent(context, DoorGeofenceReceiver::class.java)
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    companion object {
        private const val TAG = "GeofenceManager"
    }
}
