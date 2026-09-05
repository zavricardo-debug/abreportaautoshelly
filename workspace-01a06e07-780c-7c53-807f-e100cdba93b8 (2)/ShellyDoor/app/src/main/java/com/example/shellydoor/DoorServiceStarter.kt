package com.example.shellydoor

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Arranca o [DoorService] em foreground de forma segura.
 *
 * NUNCA deve rebentar a app: se a permissão de localização ainda não foi concedida
 * (ou o start for proibido), simplesmente NÃO arranca o serviço — a app continua
 * aberta e o utilizador é que arma a automação depois de dar as permissões.
 */
object DoorServiceStarter {

    private const val TAG = "DoorServiceStarter"

    fun ensureRunning(context: Context) {
        // Arrancar um foreground service de localização exige a permissão de
        // localização já concedida (nomeadamente em Android 12+ / 14). Sem ela,
        // o arranque lançaria uma SecurityException e rebentaria a app.
        val hasLocation = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasLocation) {
            Log.w(TAG, "Sem permissão de localização; não vou arrancar o serviço.")
            return
        }

        try {
            val intent = Intent(context, DoorService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (e: Exception) {
            // Nunca deixar a app cair por causa do serviço.
            Log.e(TAG, "Falha ao arrancar serviço: ${e.message}", e)
        }
    }
}
