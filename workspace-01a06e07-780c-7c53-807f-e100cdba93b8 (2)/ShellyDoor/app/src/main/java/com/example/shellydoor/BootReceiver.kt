package com.example.shellydoor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Re-arma a automação depois de o telemóvel reiniciar ou de a app ser atualizada. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.LOCKED_BOOT_COMPLETED",
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.i(TAG, "${intent.action} — a rearmar a automação")
                if (Prefs(context).autoEnabled) {
                    DoorServiceStarter.ensureRunning(context.applicationContext)
                }
            }
        }
    }

    private companion object {
        const val TAG = "BootReceiver"
    }
}
