package com.example.shellydoor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Re-arma a automação depois de o telemóvel reiniciar. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i(TAG, "Boot completo — a tentar rearmar a automação")
            if (Prefs(context).autoEnabled) {
                DoorServiceStarter.ensureRunning(context.applicationContext)
            }
        }
    }
    private companion object {
        const val TAG = "BootReceiver"
    }
}
