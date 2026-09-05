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
 * (ou o start for proibido), simplesmente NÃO arranca o serviço.
 */
object DoorServiceStarter {

    private const val TAG = "DoorServiceStarter"

    fun ensureRunning(context: Context) {
        val app = context.applicationContext

        if (!Prefs(app).autoEnabled) {
            Log.i(TAG, "Automação desligada; não arranco o serviço.")
            return
        }

        val hasLocation = ContextCompat.checkSelfPermission(
            app, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasLocation) {
            Log.w(TAG, "Sem permissão de localização; não vou arrancar o serviço.")
            return
        }

        try {
            val intent = Intent(app, DoorService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent)
            } else {
                app.startService(intent)
            }
        } catch (e: Exception) {
            // Nunca deixar a app cair por causa do serviço.
            Log.e(TAG, "Falha ao arrancar serviço: ${e.message}", e)
        }
    }
}
