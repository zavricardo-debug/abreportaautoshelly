package com.example.shellydoor

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.WifiManager

/**
 * Verifica se o telemóvel está ligado ao Wi-Fi de casa de uma [Door] concreta.
 * É o kill-switch anti-abertura: se estamos ligados à rede doméstica daquela
 * morada, consideramos que estamos dentro e NÃO abrimos automaticamente.
 *
 * ### Proteção na troca de rede (grace period) — POR MORADA
 * Ao trocar de rede dentro de casa (ex.: 5G → 2.4G do mesmo router, ou mudar de
 * ponto de acesso), o SSID atual fica momentaneamente vazio durante 1–5 s. Nesse
 * instante a app poderia pensar "saí de casa" e abrir a porta a caminho da entrada.
 *
 * Para o evitar, registamos a última vez que estivemos no Wi-Fi de casa de CADA
 * morada ([Door.lastHomeWifiAt]) e, mesmo sem estarmos ligados agora, se isso
 * aconteceu há menos de `networkGraceSeconds` segundos continuamos a considerar
 * que estamos em casa (bloqueia). Só depois do intervalo expirar é que a automação
 * rearma para aquela morada.
 */
class WifiHomeChecker(
    private val context: Context,
    private val prefs: Prefs,
    private val store: DoorStore
) {

    @SuppressLint("MissingPermission")
    fun currentSsid(): String? {
        return try {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val info = wifi.connectionInfo ?: return null
            info.ssid?.trim('"') ?: return null
        } catch (e: Exception) {
            null
        }
    }

    /** Lê o SSID atual e, para cada morada cujo SSID corresponda, atualiza o
     *  "última vez em casa" dessa morada. Chamado periodicamente pelo [DoorService].
     */
    fun recordIfHome() {
        val cur = currentSsid() ?: return
        var changed = false
        val doors = store.all()
        doors.forEach { d ->
            if (d.enabled && d.wifiKillEnabled && d.matchesHome(cur)) {
                d.lastHomeWifiAt = System.currentTimeMillis()
                changed = true
            }
        }
        if (changed) store.updateAll(doors)
    }

    /** true = estamos (ou estivemos recentemente) em casa da morada `door` → bloquear. */
    fun isAtHome(door: Door): Boolean {
        if (!door.wifiKillEnabled) return false

        // Ligado neste momento ao Wi-Fi de casa desta morada?
        val cur = currentSsid()
        if (cur != null && door.matchesHome(cur)) return true

        // Grace period por morada: estivemos no Wi-Fi de casa há menos de N segundos?
        val graceMs = prefs.networkGraceSeconds * 1000L
        if (graceMs > 0 && System.currentTimeMillis() - door.lastHomeWifiAt < graceMs) {
            return true
        }
        return false
    }
}
