package com.example.shellydoor

import org.json.JSONObject
import java.util.UUID

/**
 * Modelo de uma "porta" (morada). Cada porta é totalmente independente:
 * tem o seu nome, as suas coordenadas, o seu raio, o seu Wi-Fi de casa e o seu
 * próprio Shelly (modo, IP, nuvem, canal, impulso).
 *
 * ### Estado de "armada" (o que faz a porta abrir quando chegas)
 * A automação de cada morada só dispara depois de te teres **afastado** dela
 * (mais do que `raio + margem`). Nesse momento a morada fica **armada**
 * ([armed] = true). Quando voltas a entrar no raio, dispara e desarma.
 * É isto que impede a porta de abrir enquanto estás em casa e, ao mesmo tempo,
 * garante que abre mesmo que o telemóvel se ligue ao Wi-Fi de casa já à entrada.
 */
data class Door(
    var id: String = UUID.randomUUID().toString(),
    var name: String = "Morada",
    var enabled: Boolean = true,       // automação desta porta ativa?
    var lat: Double = 0.0,
    var lng: Double = 0.0,
    var radiusM: Float = 35f,
    var wifiKillEnabled: Boolean = true,
    var homeSsid: String = "",          // SSID(s) separados por vírgula
    var controlMode: String = "cloud",  // "local" | "cloud"
    var shellIp: String = "192.168.1.100",
    var cloudHost: String = "https://shelly-37-eu.shelly.cloud",
    var cloudDeviceId: String = "441793a5621c",
    var cloudAuthKey: String = "",
    var channel: Int = 0,
    var relayPulseSeconds: Int = 1,
    var lastHomeWifiAt: Long = 0L,  // última vez que esteve no Wi-Fi de casa desta morada

    // ---- Estado de funcionamento (por morada) ----
    /** true = já te afastaste desta morada, logo a chegada pode disparar. */
    var armed: Boolean = false,
    var lastArmedAt: Long = 0L,
    /** Última abertura DESTA morada (cooldown por morada, não global). */
    var lastOpenAt: Long = 0L,
    /** Pausa própria desta morada (auto-pausa depois de abrir). */
    var pauseUntil: Long = 0L,
    /** Última distância conhecida (metros) — só para diagnóstico no ecrã. */
    var lastDistanceM: Float = -1f,
    var lastSeenAt: Long = 0L,
    /** Último motivo de bloqueio/última mensagem desta morada (diagnóstico). */
    var lastReason: String = ""
) {
    fun hasPoint(): Boolean = lat != 0.0 && lng != 0.0

    /** O SSID indicado é um dos "de casa" desta morada (kill-switch)? */
    fun matchesHome(ssid: String): Boolean {
        if (!wifiKillEnabled) return false
        val homes = homeSsid.split(',').map { it.trim() }.filter { it.isNotEmpty() }
        return homes.any { it.equals(ssid, ignoreCase = true) }
    }

    fun isPaused(): Boolean = System.currentTimeMillis() < pauseUntil

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("name", name); put("enabled", enabled)
        put("lat", lat); put("lng", lng); put("radiusM", radiusM.toDouble())
        put("wifiKill", wifiKillEnabled); put("homeSsid", homeSsid)
        put("mode", controlMode); put("ip", shellIp); put("cloudHost", cloudHost)
        put("deviceId", cloudDeviceId); put("authKey", cloudAuthKey)
        put("channel", channel); put("pulse", relayPulseSeconds)
        put("lastHomeWifiAt", lastHomeWifiAt)
        put("armed", armed); put("lastArmedAt", lastArmedAt)
        put("lastOpenAt", lastOpenAt); put("pauseUntil", pauseUntil)
        put("lastDistanceM", lastDistanceM.toDouble()); put("lastSeenAt", lastSeenAt)
        put("lastReason", lastReason)
    }

    companion object {
        fun fromJson(o: JSONObject) = Door(
            id = o.optString("id", UUID.randomUUID().toString()),
            name = o.optString("name", "Morada"),
            enabled = o.optBoolean("enabled", true),
            lat = o.optDouble("lat", 0.0),
            lng = o.optDouble("lng", 0.0),
            radiusM = o.optDouble("radiusM", 35.0).toFloat(),
            wifiKillEnabled = o.optBoolean("wifiKill", true),
            homeSsid = o.optString("homeSsid", ""),
            controlMode = o.optString("mode", "cloud"),
            shellIp = o.optString("ip", "192.168.1.100"),
            cloudHost = o.optString("cloudHost", "https://shelly-37-eu.shelly.cloud"),
            cloudDeviceId = o.optString("deviceId", "441793a5621c"),
            cloudAuthKey = o.optString("authKey", ""),
            channel = o.optInt("channel", 0),
            relayPulseSeconds = o.optInt("pulse", 1),
            lastHomeWifiAt = o.optLong("lastHomeWifiAt", 0L),
            armed = o.optBoolean("armed", false),
            lastArmedAt = o.optLong("lastArmedAt", 0L),
            lastOpenAt = o.optLong("lastOpenAt", 0L),
            pauseUntil = o.optLong("pauseUntil", 0L),
            lastDistanceM = o.optDouble("lastDistanceM", -1.0).toFloat(),
            lastSeenAt = o.optLong("lastSeenAt", 0L),
            lastReason = o.optString("lastReason", "")
        )
    }
}
