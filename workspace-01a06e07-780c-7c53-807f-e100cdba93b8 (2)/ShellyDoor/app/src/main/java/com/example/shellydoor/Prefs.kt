package com.example.shellydoor

import android.content.Context
import android.content.SharedPreferences

/**
 * Definições GLOBAIS (partilhadas por todas as portas):
 *  - velocidade máxima, cooldown, precisão mínima do GPS
 *  - pausa (para não abrir sempre que estás à conversa)
 *  - estado e último resultado da automação
 *
 * Tudo o que é específico de cada morada (coordenadas, raio, Shelly, Wi-Fi de casa,
 * estado "armada", cooldown e pausa próprios) vive no [Door] e no [DoorStore].
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("shellydoor_prefs", Context.MODE_PRIVATE)

    /** Master switch: liga/desliga toda a automação de uma vez. */
    var autoEnabled: Boolean
        get() = sp.getBoolean(KEY_AUTO, true)
        set(v) = sp.edit().putBoolean(KEY_AUTO, v).apply()

    /**
     * Velocidade máxima (m/s) para não abrir quando passas de carro.
     * Só é aplicada quando a localização traz uma velocidade fiável.
     * Por defeito 8 m/s (~29 km/h): a pé nunca bloqueia, de carro sim.
     */
    var maxSpeedMs: Float
        get() = sp.getFloat(KEY_SPEED, 8.0f)
        set(v) = sp.edit().putFloat(KEY_SPEED, v).apply()

    /** Intervalo mínimo (ms) entre duas aberturas automáticas DA MESMA morada. */
    var cooldownMs: Long
        get() = sp.getLong(KEY_COOLDOWN, 30_000L)
        set(v) = sp.edit().putLong(KEY_COOLDOWN, v).apply()

    var lastOpenTimestamp: Long
        get() = sp.getLong(KEY_LAST_OPEN, 0L)
        set(v) = sp.edit().putLong(KEY_LAST_OPEN, v).apply()

    var lastResult: String
        get() = sp.getString(KEY_LAST_RESULT, "-") ?: "-"
        set(v) = sp.edit().putString(KEY_LAST_RESULT, v).apply()

    // ------------------------------------------------------------------
    // Aproximação / armar (o que resolve o "não abre quando chego à porta")
    // ------------------------------------------------------------------

    /**
     * Margem (metros) a somar ao raio para considerar que SAÍSTE mesmo da morada
     * e portanto a automação pode voltar a armar. Ex.: raio 35 m + margem 60 m →
     * tens de te afastar mais de 95 m para a porta voltar a ficar "armada".
     * Isto é o que impede reaberturas enquanto andas à volta do prédio.
     */
    var rearmMarginM: Float
        get() = sp.getFloat(KEY_REARM_MARGIN, 10f)
        set(v) = sp.edit().putFloat(KEY_REARM_MARGIN, v).apply()

    /**
     * Segundos que tens de estar CONTINUAMENTE longe (além de raio+margem)
     * para a morada armar.
     *
     * É isto — e não o Wi-Fi — que distingue "saí de casa" de "estou a passar
     * pela porta a caminho da rua". Ao sair, ainda estás perto da porta, por
     * isso a morada não arma e a porta não abre atrás de ti.
     */
    var awayConfirmSeconds: Int
        get() = sp.getInt(KEY_AWAY_CONFIRM, 30)
        set(v) = sp.edit().putInt(KEY_AWAY_CONFIRM, v).apply()

    /**
     * Precisão mínima aceitável do GPS (metros). Só recusamos fixes PIORES do que
     * isto. Valor propositadamente generoso (120 m): entre prédios o telemóvel dá
     * facilmente ±40–80 m e mesmo assim estás mesmo à porta — ser estrito aqui era
     * recriar o problema de "não abre quando chego".
     */
    var minAccuracyM: Float
        get() = sp.getFloat(KEY_MIN_ACC, 120f)
        set(v) = sp.edit().putFloat(KEY_MIN_ACC, v).apply()

    /**
     * Rastreio ativo de localização no serviço em foreground. É o que faz a porta
     * abrir *mesmo* à chegada; os geofences do sistema, sozinhos, chegam muitas
     * vezes atrasados (ou nem chegam, com o ecrã desligado).
     */
    var activeTracking: Boolean
        get() = sp.getBoolean(KEY_ACTIVE_TRACK, true)
        set(v) = sp.edit().putBoolean(KEY_ACTIVE_TRACK, v).apply()

    /** Período (segundos) entre fixes quando estás longe de todas as moradas. */
    var farIntervalSec: Int
        get() = sp.getInt(KEY_FAR_INT, 45)
        set(v) = sp.edit().putInt(KEY_FAR_INT, v).apply()

    /** Período (segundos) entre fixes quando estás perto de alguma morada. */
    var nearIntervalSec: Int
        get() = sp.getInt(KEY_NEAR_INT, 4)
        set(v) = sp.edit().putInt(KEY_NEAR_INT, v).apply()

    // ---- Rede / troca de Wi-Fi (proteção anti-abertura falsa) ----
    /** Janela (segundos) em que, mesmo sem estares ligado ao Wi-Fi de casa,
     *  continuamos a considerar que estás em casa. Evita abrir na troca 5G/2.4G.
     *  O valor é GLOBAL; o timestamp "última vez em casa" é POR MORADA (Door).
     *
     *  NOTA: já NÃO impede a morada de armar (isso agora é só distância+tempo,
     *  ver [awayConfirmSeconds]). Só é usado quando ligas explicitamente o
     *  [wifiBlocksWhenArmed]. */
    var networkGraceSeconds: Int
        get() = sp.getInt(KEY_NET_GRACE, 20)
        set(v) = sp.edit().putInt(KEY_NET_GRACE, v).apply()

    /**
     * O Wi-Fi de casa bloqueia a abertura mesmo quando a morada já está armada
     * (ou seja, mesmo depois de teres saído e voltado)?
     *
     * **Por defeito NÃO** — e é esta a correção principal: o telemóvel apanha
     * frequentemente o Wi-Fi de casa ainda na rua, a 20–40 m da porta, e com o
     * comportamento antigo isso bloqueava a abertura exatamente quando chegavas.
     * Com `armed`, saber que saíste é prova suficiente de que estás a chegar.
     */
    var wifiBlocksWhenArmed: Boolean
        get() = sp.getBoolean(KEY_WIFI_BLOCKS_ARMED, false)
        set(v) = sp.edit().putBoolean(KEY_WIFI_BLOCKS_ARMED, v).apply()

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

    /**
     * Auto-pausa depois de abrir. Por defeito DESLIGADA: a auto-pausa global
     * antiga deixava as outras moradas (e a própria) mudas durante 10 minutos.
     * O rearme por distância já resolve o "abrir outra vez enquanto conversas".
     */
    var autoPauseAfterOpen: Boolean
        get() = sp.getBoolean(KEY_AUTO_PAUSE, false)
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
        private const val KEY_WIFI_BLOCKS_ARMED = "wifiBlocksWhenArmed"
        private const val KEY_AUTH_KEY_GLOBAL = "cloudAuthKeyGlobal"
        private const val KEY_LAST_OPEN = "lastOpen"
        private const val KEY_LAST_RESULT = "lastResult"
        private const val KEY_PAUSE_MIN = "pauseMinutes"
        private const val KEY_AUTO_PAUSE = "autoPauseAfterOpen"
        private const val KEY_PAUSE_UNTIL = "pauseUntil"
        private const val KEY_REARM_MARGIN = "rearmMarginM"
        private const val KEY_AWAY_CONFIRM = "awayConfirmSeconds"
        private const val KEY_MIN_ACC = "minAccuracyM"
        private const val KEY_ACTIVE_TRACK = "activeTracking"
        private const val KEY_FAR_INT = "farIntervalSec"
        private const val KEY_NEAR_INT = "nearIntervalSec"
    }
}
