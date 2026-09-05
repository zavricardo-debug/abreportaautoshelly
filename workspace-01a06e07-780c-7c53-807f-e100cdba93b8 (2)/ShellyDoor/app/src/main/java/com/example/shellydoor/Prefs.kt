package com.example.shellydoor

import android.content.Context
import android.content.SharedPreferences

/**
 * Definições GLOBAIS (partilhadas por todas as portas):
 *  - velocidade máxima, cooldown
 *  - pausa (para não abrir sempre que estás à conversa)
 *  - estado e último resultado da automação
 *
 * Tudo o que é específico de cada morada (coordenadas, raio, Shelly, Wi-Fi de casa)
 * vive no [Door] e no [DoorStore].
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("shellydoor_prefs", Context.MODE_PRIVATE)

    /** Master swatch: liga/desliga toda a automação de uma vez. */
    var autoEnabled: Boolean
        get() = sp.getBoolean(KEY_AUTO, true)
        set(v) = sp.edit().putBoolean(KEY_AUTO, v).apply()

    /** Velocidade máxima (m/s) para não abrir quando passas de carro. */
    var maxSpeedMs: Float
        get() = sp.getFloat(KEY_SPEED, 3.0f)
        set(v) = sp.edit().putFloat(KEY_SPEED, v).apply()

    /** Intervalo mínimo (ms) entre duas aberturas automáticas. */
    var cooldownMs: Long
        get() = sp.getLong(KEY_COOLDOWN, 30_000L)
        set(v) = sp.edit().putLong(KEY_COOLDOWN, v).apply()

    var lastOpenTimestamp: Long
        get() = sp.getLong(KEY_LAST_OPEN, 0L)
        set(v) = sp.edit().putLong(KEY_LAST_OPEN, v).apply()

    var lastResult: String
        get() = sp.getString(KEY_LAST_RESULT, "-") ?: "-"
        set(v) = sp.edit().putString(KEY_LAST_RESULT, v).apply()

    // ---- Rede / troca de Wi-Fi (proteção anti-abertura falsa) ----
    /** Janela (segundos) em que, mesmo sem estares ligado ao Wi-Fi de casa,
     *  continuamos a considerar que estás em casa. Evita abrir na troca 5G/2.4G.
     *  O valor é GLOBAL; o timestamp "última vez em casa" é POR MORADA (Door). */
    var networkGraceSeconds: Int
        get() = sp.getInt(KEY_NET_GRACE, 60)
        set(v) = sp.edit().putInt(KEY_NET_GRACE, v).apply()

    // ---- Auth key GLOBAL (partilhado por todas as moradas) ----
    // Como todos os Shellys estão na mesma conta de nuvem, partilham o mesmo
    // auth_key. Se uma morada tiver o campo vazio, usa-se este valor global.
    var cloudAuthKeyGlobal: String
        get() = sp.getString(KEY_AUTH_KEY_GLOBAL, "") ?: ""
        set(v) = sp.edit().putString(KEY_AUTH_KEY_GLOBAL, v).apply()

    // ---- Pausa ----
    var pauseMinutes: Int
        get() = sp.getInt(KEY_PAUSE_MIN, 10)
        set(v) = sp.edit().putInt(KEY_PAUSE_MIN, v).apply()

    var autoPauseAfterOpen: Boolean
        get() = sp.getBoolean(KEY_AUTO_PAUSE, true)
        set(v) = sp.edit().putBoolean(KEY_AUTO_PAUSE, v).apply()

    var pauseUntil: Long
        get() = sp.getLong(KEY_PAUSE_UNTIL, 0L)
        set(v) = sp.edit().putLong(KEY_PAUSE_UNTIL, v).apply()

    fun applyPause(minutes: Int) { pauseUntil = System.currentTimeMillis() + minutes * 60_000L }
    fun clearPause() { pauseUntil = 0L }
    fun isPaused(): Boolean = System.currentTimeMillis() < pauseUntil
    fun pauseRemainingMillis(): Long = if (isPaused()) pauseUntil - System.currentTimeMillis() else 0L

    companion object {
        private const val KEY_AUTO = "autoEnabled"
        private const val KEY_SPEED = "maxSpeedMs"
        private const val KEY_COOLDOWN = "cooldownMs"
        private const val KEY_NET_GRACE = "networkGraceSeconds"
        private const val KEY_AUTH_KEY_GLOBAL = "cloudAuthKeyGlobal"
        private const val KEY_LAST_OPEN = "lastOpen"
        private const val KEY_LAST_RESULT = "lastResult"
        private const val KEY_PAUSE_MIN = "pauseMinutes"
        private const val KEY_AUTO_PAUSE = "autoPauseAfterOpen"
        private const val KEY_PAUSE_UNTIL = "pauseUntil"
    }
}
