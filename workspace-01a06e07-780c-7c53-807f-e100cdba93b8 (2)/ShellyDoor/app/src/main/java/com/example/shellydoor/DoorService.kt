package com.example.shellydoor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Serviço em foreground: é ele que faz a porta abrir à chegada.
 *
 * Faz três coisas:
 *  1. **Rastreio ativo de localização** — a razão principal desta classe existir.
 *     Os geofences do sistema chegam com atraso (por vezes minutos, ou só quando
 *     o telemóvel acorda), o que dava exatamente o sintoma "estou à frente da
 *     porta e não abre". Com um `LocationRequest` próprio avaliamos a distância
 *     em segundos.
 *  2. **Ritmo adaptativo** — longe de casa pede fixes de 45 em 45 s (poupa
 *     bateria); a menos de ~400 m de uma morada acelera para 4 s.
 *  3. **Polling do Wi-Fi** — mantém fresco o "última vez em casa" de cada morada.
 *
 * Os geofences continuam registados como rede de segurança ([GeofenceManager]).
 */
class DoorService : Service() {

    private var geoManager: GeofenceManager? = null
    private val prefs by lazy { Prefs(this) }
    private val store by lazy { DoorStore(this) }
    private val wifi by lazy { WifiHomeChecker(this, prefs, store) }
    private val handler = Handler(Looper.getMainLooper())
    private var wifiPoll: Runnable? = null

    private var fused: FusedLocationProviderClient? = null
    private var locationCallback: LocationCallback? = null
    private var currentIntervalMs: Long = -1L

    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        geoManager = GeofenceManager(this)
        fused = LocationServices.getFusedLocationProviderClient(this)
        try {
            startForegroundInternal("A arrancar…")
        } catch (e: Exception) {
            Log.e(TAG, "Não consigo entrar em foreground: ${e.message}", e)
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (prefs.autoEnabled) {
            geoManager?.registerAll()
            startWifiPolling()
            if (prefs.activeTracking) startLocationUpdates(prefs.farIntervalSec * 1000L)
        } else {
            stopLocationUpdates()
            stopWifiPolling()
        }
        updateStatusNotification()
        return START_STICKY
    }

    override fun onDestroy() {
        geoManager?.unregister()
        stopWifiPolling()
        stopLocationUpdates()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ------------------------------------------------------------------
    // Rastreio de localização
    // ------------------------------------------------------------------

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    private fun startLocationUpdates(intervalMs: Long) {
        if (!hasLocationPermission()) {
            Log.w(TAG, "Sem permissão de localização — sem rastreio ativo.")
            return
        }
        if (currentIntervalMs == intervalMs && locationCallback != null) return

        stopLocationUpdates()

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            .setMaxUpdateDelayMillis(intervalMs * 2)
            .setWaitForAccurateLocation(false)
            .build()

        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { onNewLocation(it) }
            }
        }

        try {
            fused?.requestLocationUpdates(request, cb, Looper.getMainLooper())
            locationCallback = cb
            currentIntervalMs = intervalMs
            Log.i(TAG, "Rastreio ativo a cada ${intervalMs / 1000}s")
        } catch (e: Exception) {
            Log.e(TAG, "Falha a pedir localização: ${e.message}", e)
        }
    }

    private fun stopLocationUpdates() {
        locationCallback?.let { fused?.removeLocationUpdates(it) }
        locationCallback = null
        currentIntervalMs = -1L
    }

    private fun onNewLocation(location: Location) {
        val nearest = ApproachEvaluator.evaluate(this, location, "tracking")

        // Ritmo adaptativo: perto → rápido, longe → lento.
        val near = nearest <= NEAR_THRESHOLD_M
        val wanted = (if (near) prefs.nearIntervalSec else prefs.farIntervalSec) * 1000L
        if (wanted != currentIntervalMs) startLocationUpdates(wanted)

        updateStatusNotification(nearest)
    }

    // ------------------------------------------------------------------
    // Wi-Fi
    // ------------------------------------------------------------------

    private fun startWifiPolling() {
        stopWifiPolling()
        val r = object : Runnable {
            override fun run() {
                wifi.recordIfHome()
                handler.postDelayed(this, WIFI_POLL_MS)
            }
        }
        wifiPoll = r
        handler.post(r)
    }

    private fun stopWifiPolling() {
        wifiPoll?.let { handler.removeCallbacks(it) }
        wifiPoll = null
    }

    // ------------------------------------------------------------------
    // Notificação de estado (também serve de diagnóstico)
    // ------------------------------------------------------------------

    private fun updateStatusNotification(nearest: Float = -1f) {
        try {
            startForegroundInternal(statusText(nearest))
        } catch (e: Exception) {
            Log.w(TAG, "Não consegui atualizar a notificação: ${e.message}")
        }
    }

    private fun statusText(nearest: Float): String {
        if (!prefs.autoEnabled) return "Automação desligada"
        val doors = store.all().filter { it.enabled && it.hasPoint() }
        if (doors.isEmpty()) return "Sem moradas com ponto definido"
        val armed = doors.count { it.armed }
        val dist = if (nearest in 0f..999_999f) " · mais perto: %.0f m".format(nearest) else ""
        return "A vigiar ${doors.size} morada(s) · $armed armada(s)$dist"
    }

    private fun startForegroundInternal(status: String) {
        val notif = Notifier.statusNotification(this, status)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(1, notif)
        }
    }

    companion object {
        private const val TAG = "DoorService"
        private const val WIFI_POLL_MS = 5_000L
        /** A menos desta distância de uma morada, acelera o GPS. */
        private const val NEAR_THRESHOLD_M = 400f
    }
}
