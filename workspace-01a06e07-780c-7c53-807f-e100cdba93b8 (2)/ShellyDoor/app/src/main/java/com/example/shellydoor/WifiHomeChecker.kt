package com.example.shellydoor

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build

/**
 * Verifica se o telemóvel está ligado ao Wi-Fi de casa de uma [Door] concreta.
 *
 * ### Onde é que isto conta (mudou!)
 * O Wi-Fi de casa deixou de ser o "kill-switch" no momento da chegada — porque o
 * telemóvel apanha a rede de casa já na rua e isso impedia a porta de abrir
 * quando estavas mesmo à frente dela. Agora o Wi-Fi serve para **impedir que a
 * morada arme** enquanto estás em casa (ver [DoorDecisionEngine]). Depois de
 * teres saído a sério, a chegada abre a porta esteja o Wi-Fi ligado ou não
 * (a menos que ligues `wifiBlocksWhenArmed` nas definições).
 *
 * ### Grace period (troca de rede 5G ↔ 2.4G)
 * Ao trocar de banda/AP o SSID fica momentaneamente vazio. Guardamos a última
 * vez que estivemos no Wi-Fi de casa de CADA morada ([Door.lastHomeWifiAt]) e,
 * durante `networkGraceSeconds`, continuamos a considerar que estamos em casa.
 */
class WifiHomeChecker(
    private val context: Context,
    private val prefs: Prefs,
    private val store: DoorStore
) {

    /** Estamos sequer ligados a uma rede Wi-Fi neste momento? */
    private fun wifiConnected(): Boolean = try {
        val cm = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    } catch (e: Exception) {
        false
    }

    /**
     * SSID atual, ou null se não estivermos em Wi-Fi / não for legível.
     *
     * Atenção: a partir do Android 10 o `connectionInfo.ssid` devolve
     * `<unknown ssid>` sem permissão de localização concedida. Nesse caso
     * devolvemos null (desconhecido) em vez de uma string inútil, para não
     * comparar lixo com o SSID de casa.
     */
    @SuppressLint("MissingPermission")
    fun currentSsid(): String? {
        if (!wifiConnected()) return null
        return try {
            val wifi = context.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val info = wifi.connectionInfo ?: return null
            @Suppress("DEPRECATION")
            val raw = info.ssid?.trim('"')?.trim() ?: return null
            if (raw.isEmpty() ||
                raw.equals("<unknown ssid>", ignoreCase = true) ||
                raw.equals("0x", ignoreCase = true)
            ) null else raw
        } catch (e: Exception) {
            null
        }
    }

    /** Lê o SSID atual e atualiza o "última vez em casa" das moradas que batem certo. */
    fun recordIfHome() {
        val cur = currentSsid()
        val now = System.currentTimeMillis()
        var changed = false
        val doors = store.all()
        doors.forEach { d ->
            val home = cur != null && d.enabled && d.wifiKillEnabled && d.matchesHome(cur)
            if (home) {
                d.lastHomeWifiAt = now
                // Só marca o inicio na PRIMEIRA leitura ligada; enquanto se
                // mantiver ligado, o instante original preserva-se.
                if (d.homeWifiSinceAt == 0L) d.homeWifiSinceAt = now
                changed = true
            } else if (d.homeWifiSinceAt != 0L) {
                // Saiu do Wi-Fi de casa: a contagem recomeça do zero.
                d.homeWifiSinceAt = 0L
                changed = true
            }
        }
        if (changed) store.updateAll(doors)
    }

    /** Há quantos segundos está ligado, sem interrupção, ao Wi-Fi de casa. -1 = não está. */
    fun homeWifiSteadySeconds(door: Door): Long {
        if (!isConnectedToHomeNow(door)) return -1L
        if (door.homeWifiSinceAt <= 0L) return 0L
        return (System.currentTimeMillis() - door.homeWifiSinceAt) / 1000
    }

    /** true = estamos (ou estivemos mesmo agora) no Wi-Fi de casa desta morada. */
    /**
     * Ligado AGORA ao Wi-Fi de casa desta morada? Sem janela de graça.
     *
     * Diferente de [isAtHome]: aqui não vale o "esteve ligado há pouco". Serve
     * para distinguir "estou mesmo dentro de casa" de "vou a chegar e o
     * telemóvel ainda agora engatou o router".
     */
    fun isConnectedToHomeNow(door: Door): Boolean {
        if (!door.wifiKillEnabled) return false
        if (door.homeSsid.isBlank()) return false
        val cur = currentSsid() ?: return false
        return door.matchesHome(cur)
    }

    fun isAtHome(door: Door): Boolean {
        if (!door.wifiKillEnabled) return false
        if (door.homeSsid.isBlank()) return false   // sem SSID configurado não bloqueia nada

        val cur = currentSsid()
        if (cur != null && door.matchesHome(cur)) return true

        val graceMs = prefs.networkGraceSeconds * 1000L
        return graceMs > 0 &&
                door.lastHomeWifiAt > 0L &&
                System.currentTimeMillis() - door.lastHomeWifiAt < graceMs
    }

    @Suppress("unused")
    private fun apiAtLeastQ() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
}
