package com.example.shellydoor

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Controlador do Shelly — adaptado à API HTTP do Shelly Cloud (2.ª geração).
 * Abre a porta do objeto [Door] passado (cada morada tem o seu próprio Shelly).
 *
 *   POST {host}/device/relay/control  → channel, turn=on, [timer], id, auth_key
 *   POST {host}/device/status         → id, auth_key
 *
 * O pulso usa o parâmetro `timer`: liga o relé e desliga-o sozinho após N segundos.
 *
 * Nota: [openDoor] é NÃO-suspend (fire-and-forget) e corre o trabalho de rede num
 * scope interno. Assim é chamável a partir de BroadcastReceivers, callbacks e
 * listeners de UI sem precisar de um CoroutineScope exterior.
 */
class ShellyController(private val prefs: Prefs) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Envia o impulso de abertura. Devolve o resultado via [onResult] (num thread de IO). */
    fun openDoor(door: Door, onResult: (Boolean, String) -> Unit) {
        scope.launch {
            try {
                val ok = if (door.controlMode == "cloud") {
                    controlRelay(door, "on", door.relayPulseSeconds)
                } else {
                    val on = controlRelayLocal(door, "on")
                    if (on) {
                        Thread.sleep(door.relayPulseSeconds * 1000L)
                        controlRelayLocal(door, "off")
                    } else false
                }

                if (ok) {
                    prefs.lastOpenTimestamp = System.currentTimeMillis()
                    prefs.lastResult = "Porta aberta ✓ (${door.name})"
                    onResult(true, "Porta aberta ✓")
                } else {
                    prefs.lastResult = "Falha ao ligar o relé (${door.name})"
                    onResult(false, "Falha ao ligar o relé")
                }
            } catch (e: Exception) {
                val msg = "Erro: ${e.message}"
                Log.e(TAG, msg, e)
                prefs.lastResult = msg
                onResult(false, msg)
            }
        }
    }

    /** Auth key a usar para uma morada: o dela se existir, senão o global. */
    private fun authKeyFor(door: Door): String {
        val local = door.cloudAuthKey.trim()
        val global = prefs.cloudAuthKeyGlobal.trim()
        return local.ifEmpty { global }
    }

    private fun controlRelay(door: Door, turn: String, timerSeconds: Int): Boolean {
        val form = FormBody.Builder()
            .add("channel", door.channel.toString())
            .add("turn", turn)
            .add("id", door.cloudDeviceId)
            .add("auth_key", authKeyFor(door))
        if (timerSeconds > 0) form.add("timer", timerSeconds.toString())
        val url = "${door.cloudHost.trimEnd('/')}/device/relay/control"
        return execJson(Request.Builder().url(url).post(form.build()).build())
    }

    private fun controlRelayLocal(door: Door, turn: String): Boolean {
        val url = "http://${door.shellIp}/relay/0?turn=$turn"
        val req = Request.Builder().url(url).get().build()
        return try {
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            Log.e(TAG, "local: ${e.message}"); false
        }
    }

    private fun execJson(request: Request): Boolean {
        client.newCall(request).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            Log.d(TAG, "HTTP ${resp.code} $body")
            if (!resp.isSuccessful) return false
            val obj = JSONObject(body)
            return obj.optBoolean("isok", false) ||
                    (obj.has("data") && obj.optJSONObject("data")?.optBoolean("isok", false) == true)
        }
    }

    companion object {
        private const val TAG = "ShellyController"
    }
}
