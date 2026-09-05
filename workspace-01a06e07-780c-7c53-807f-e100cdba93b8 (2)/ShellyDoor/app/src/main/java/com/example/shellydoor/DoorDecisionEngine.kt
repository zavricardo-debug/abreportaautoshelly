package com.example.shellydoor

import android.location.Location

/**
 * Motor de decisão — a "sensibilidade". Opera sobre uma [Door] concreta.
 *
 * ## O modelo: ARMAR ao sair, DISPARAR ao chegar
 *
 * O problema do modelo antigo era este: a decisão dependia de o telemóvel *não*
 * estar no Wi-Fi de casa no instante em que chegavas. Mas o telemóvel apanha o
 * Wi-Fi de casa na rua, a dezenas de metros da porta — ou seja, exatamente no
 * momento em que devia abrir, o kill-switch bloqueava. Resultado: a porta não
 * abria quando estavas à frente dela.
 *
 * Agora cada morada tem um estado [Door.armed]:
 *
 *  - **Desarma** ao abrir (ou ao estares dentro do raio).
 *  - **Arma** quando te afastas mais do que `raio + margem de rearme` — o que só
 *    acontece se saíste mesmo. O Wi-Fi de casa (e o grace period) só contam
 *    *antes* de armar; depois de armada, chegar ao raio é suficiente.
 *  - **Dispara** na primeira leitura dentro do raio com a morada armada.
 *
 * Assim: em casa nunca abre (nunca chegou a armar), e ao voltar abre sempre,
 * esteja o Wi-Fi já ligado ou não.
 */
class DoorDecisionEngine(private val prefs: Prefs, private val wifi: WifiHomeChecker) {

    sealed class Outcome {
        /** Abrir agora. */
        data object AllowOpen : Outcome()
        /** Não abrir — com o motivo (mostrado no ecrã principal para diagnóstico). */
        data class Denied(val reason: String) : Outcome()
        /** Não abrir, e não vale a pena notificar (estado normal: longe/em casa). */
        data class Silent(val reason: String) : Outcome()
    }

    /**
     * Avalia uma leitura de posição para uma morada. Esta função **muta** o estado
     * de `door` (armar/desarmar/distância) — quem chama deve gravar a morada.
     *
     * @param distanceM distância atual (metros) à porta.
     * @param accuracyM precisão do fix (metros); <=0 = desconhecida.
     * @param speedMs   velocidade (m/s); <0 = desconhecida.
     */
    fun evaluate(door: Door, distanceM: Float, accuracyM: Float, speedMs: Float): Outcome {
        val now = System.currentTimeMillis()
        door.lastDistanceM = distanceM
        door.lastSeenAt = now

        if (!door.enabled) return silent(door, "Morada desativada")
        if (!door.hasPoint()) return silent(door, "Sem ponto definido")
        if (!prefs.autoEnabled) return silent(door, "Automação desligada")

        val radius = door.radiusM
        val rearmAt = radius + prefs.rearmMarginM

        // ---------------------------------------------------------------
        // 1) LONGE: é aqui que a morada ARMA. Sair de casa arma a automação.
        // ---------------------------------------------------------------
        if (distanceM > rearmAt) {
            if (!door.armed) {
                // Enquanto ainda não armou, o Wi-Fi de casa manda: se o telemóvel
                // ainda "vê" a rede de casa, não é uma saída a sério.
                if (wifi.isAtHome(door)) {
                    return silent(door, "Longe (%.0f m) mas ainda no Wi-Fi de casa".format(distanceM))
                }
                door.armed = true
                door.lastArmedAt = now
                return silent(door, "Armada ✓ (saíste — a %.0f m)".format(distanceM))
            }
            return silent(door, "Longe (%.0f m) — armada".format(distanceM))
        }

        // Zona intermédia (entre o raio e o ponto de rearme): não faz nada,
        // apenas mantém o estado. Serve de histerese e evita o liga-desliga.
        if (distanceM > radius) {
            val estado = if (door.armed) "armada" else "não armada"
            return silent(door, "A %.0f m ($estado)".format(distanceM))
        }

        // ---------------------------------------------------------------
        // 2) DENTRO DO RAIO: candidato a abrir.
        // ---------------------------------------------------------------
        if (!door.armed) {
            // Nunca saíste (estás em casa / continuas por aqui). Não abre — e é
            // isto que impede a porta de abrir enquanto estás no apartamento.
            return silent(door, "Perto (%.0f m) mas não armada — precisas de te afastar >%.0f m".format(distanceM, rearmAt))
        }

        // Precisão do GPS. Regra DELIBERADAMENTE permissiva: só recusamos quando
        // o fix é tão mau que não diz nada (±120 m por defeito). Ser estrito aqui
        // era voltar a criar o problema original — nas ruas estreitas o telemóvel
        // dá facilmente ±40–80 m, e mesmo assim estás mesmo à porta. O `armed`
        // já garante que só chegamos aqui depois de teres saído a sério.
        if (accuracyM > 0f && accuracyM > prefs.minAccuracyM) {
            return deny(door, "GPS impreciso (±%.0f m) — a aguardar melhor sinal".format(accuracyM))
        }

        // Velocidade: só bloqueia se a leitura for fiável e claramente alta
        // (a passar de carro). Velocidade desconhecida (-1) NUNCA bloqueia.
        if (speedMs >= 0f && speedMs > prefs.maxSpeedMs) {
            return deny(door, "Velocidade alta (%.1f m/s) — a passar?".format(speedMs))
        }

        // Pausa: global ou da própria morada.
        if (prefs.isPaused()) {
            return deny(door, "Automação em pausa (${prefs.pauseRemainingMillis() / 1000}s)")
        }
        if (door.isPaused()) {
            return deny(door, "Morada em pausa (${(door.pauseUntil - now) / 1000}s)")
        }

        // Cooldown POR MORADA (antes era global: abrir a Ladra bloqueava Alvalade).
        val since = now - door.lastOpenAt
        if (door.lastOpenAt > 0L && since < prefs.cooldownMs) {
            return deny(door, "Cooldown (${since / 1000}s de ${prefs.cooldownMs / 1000}s)")
        }

        // Opcional: manter o Wi-Fi como bloqueio mesmo depois de armada.
        if (prefs.wifiBlocksWhenArmed && wifi.isAtHome(door)) {
            return deny(door, "Ligado ao Wi-Fi de ${door.name}")
        }

        return Outcome.AllowOpen
    }

    /** Marca a morada como aberta: desarma, grava timestamps e a pausa opcional. */
    fun markOpened(door: Door) {
        val now = System.currentTimeMillis()
        door.armed = false
        door.lastOpenAt = now
        door.lastReason = "Aberta ✓"
        if (prefs.autoPauseAfterOpen) {
            door.pauseUntil = now + prefs.pauseMinutes * 60_000L
        }
    }

    private fun deny(door: Door, reason: String): Outcome {
        door.lastReason = reason
        return Outcome.Denied(reason)
    }

    private fun silent(door: Door, reason: String): Outcome {
        door.lastReason = reason
        return Outcome.Silent(reason)
    }

    companion object {
        /** Distância (metros) entre uma localização e a porta de uma morada. */
        fun distanceTo(door: Door, location: Location): Float {
            val out = FloatArray(1)
            Location.distanceBetween(location.latitude, location.longitude, door.lat, door.lng, out)
            return out[0]
        }
    }
}
