package com.example.shellydoor

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
/**
 * Serviço em foreground que mantém o geofencing de todas as portas ativo e faz
 * polling periódico do Wi-Fi, para manter o "última vez em casa" fresco. Isto é
 * o que evita abrir a porta na troca de rede dentro de casa (5G→2.4G, mudar de AP).
 */
class DoorService : Service() {

    private var geoManager: GeofenceManager? = null
    private val prefs by lazy { Prefs(this) }
    private val store by lazy { DoorStore(this) }
    private val wifi by lazy { WifiHomeChecker(this, prefs, store) }
    private val handler = Handler(Looper.getMainLooper())
    private var wincheck: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        geoManager = GeofenceManager(this)
        try {
            startForegroundInternal()
        } catch (e: Exception) {
            // Se por algum motivo não conseguirmos entrar em foreground (ex.: falta
            // de permissão de localização), paramos em segurança em vez de rebentar.
            Log.e(TAG, "Não consigo entrar em foreground: ${e.message}", e)
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (prefs.autoEnabled) {
            geoManager?.registerAll()
            startWifiPolling()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        geoManager?.unregister()
        stopWifiPolling()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startWifiPolling() {
        stopWifiPolling()
        val r = object : Runnable {
            override fun run() {
                wifi.recordIfHome()
                handler.postDelayed(this, WIFI_POLL_MS)
            }
        }
        wincheck = r
        handler.post(r)
    }

    private fun stopWifiPolling() {
        wincheck?.let { handler.removeCallbacks(it) }
        wincheck = null
    }

    private fun startForegroundInternal() {
        val n = if (prefs.autoEnabled) store.all().count { it.enabled && it.hasPoint() } else 0
        val status = if (prefs.autoEnabled) "A vigiar $n morada(s)…" else "Automação desligada"
        val notif = Notifier.statusNotification(this, status)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(1, notif)
        }
        Log.i(TAG, "Serviço em foreground iniciado")
    }

    companion object {
        private const val TAG = "DoorService"
        private const val WIFI_POLL_MS = 5_000L
    }
}
