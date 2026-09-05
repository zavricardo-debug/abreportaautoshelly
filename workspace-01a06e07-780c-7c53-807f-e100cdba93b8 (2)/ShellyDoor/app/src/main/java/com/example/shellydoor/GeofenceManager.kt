package com.example.shellydoor

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import kotlin.math.max

/**
 * Regista um geofence por morada (rede de segurança do rastreio ativo).
 *
 * Duas correções importantes:
 *  - Regista **ENTER + EXIT** (antes só ENTER). Sem o EXIT o sistema nunca
 *    avisava que te tinhas afastado, o que é meio caminho para a automação
 *    nunca rearmar.
 *  - O raio efetivo tem um **mínimo de 100 m**. O Android é pouco fiável com
 *    geofences pequenos (20–35 m): muitas vezes o ENTER simplesmente não chega,
 *    ou chega minutos depois — exatamente o sintoma "estou à porta e não abre".
 *    O raio pequeno que configuraste continua a ser respeitado: quem decide se
 *    estás mesmo à porta é o [DoorDecisionEngine], com a distância real.
 */
class GeofenceManager(private val context: Context) {

    private val client: GeofencingClient = LocationServices.getGeofencingClient(context)
    private val store = DoorStore(context)

    @SuppressLint("MissingPermission")
    fun registerAll() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "Sem permissão de localização; não registo geofences.")
            return
        }

        val doors = store.all().filter { it.enabled && it.hasPoint() }
        if (doors.isEmpty()) {
            Log.w(TAG, "Sem portas ativas com ponto definido; não registo geofences.")
            unregister()
            return
        }

        val request = GeofencingRequest.Builder()
            .setInitialTrigger(
                GeofencingRequest.INITIAL_TRIGGER_ENTER or GeofencingRequest.INITIAL_TRIGGER_EXIT
            )
        doors.forEach { door ->
            request.addGeofence(
                Geofence.Builder()
                    .setRequestId(door.id)
                    .setCircularRegion(door.lat, door.lng, max(door.radiusM, MIN_GEOFENCE_M))
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(
                        Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT
                    )
                    .setNotificationResponsiveness(NOTIF_RESPONSIVENESS_MS)
                    .build()
            )
        }

        client.removeGeofences(pendingIntent()).addOnCompleteListener {
            try {
                client.addGeofences(request.build(), pendingIntent())
                    .addOnSuccessListener {
                        Log.i(TAG, "${doors.size} geofence(s) ativos: ${doors.map { d -> d.name }}")
                        Prefs(context).lastResult = "${doors.size} morada(s) a ser vigiada(s) ✓"
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "Falha ao adicionar geofences", e)
                        Prefs(context).lastResult = "Falha geofence: ${e.message}"
                    }
            } catch (e: Exception) {
                Log.e(TAG, "Erro ao registar geofences: ${e.message}", e)
            }
        }
    }

    fun unregister() {
        try {
            client.removeGeofences(pendingIntent())
            Log.i(TAG, "Geofences removidos")
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao remover geofences: ${e.message}", e)
        }
    }

    private fun pendingIntent(): PendingIntent {
        val intent = Intent(context, DoorGeofenceReceiver::class.java)
            .setAction(ACTION_GEOFENCE)
        // O geofencing PRECISA de um PendingIntent mutável (o sistema injeta os
        // extras do evento). Em Android 12+ é obrigatório declará-lo.
        val mutability =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(
            context.applicationContext,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or mutability
        )
    }

    companion object {
        private const val TAG = "GeofenceManager"
        private const val ACTION_GEOFENCE = "com.example.shellydoor.GEOFENCE"
        /** Mínimo prático para o Android acordar de forma fiável. */
        private const val MIN_GEOFENCE_M = 100f
        private const val NOTIF_RESPONSIVENESS_MS = 0
    }
}
