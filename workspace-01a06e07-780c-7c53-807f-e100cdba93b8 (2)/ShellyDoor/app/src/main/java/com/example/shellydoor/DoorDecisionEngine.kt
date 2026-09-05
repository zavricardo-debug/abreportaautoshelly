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
        // 1) LONGE: é aqui que a morada ARMA.
        //
        // Armar exige estar longe DE FORMA CONTINUADA (`awayConfirmSeconds`),
        // e NÃO depende do Wi-Fi. Duas razões:
        //  - Ao sair de casa passas pela porta: nessa altura ainda estás perto,
        //    o contador está a zero e a morada não está armada → não abre.
        //  - Perder o Wi-Fi não é sinal de nada (pode ser só o router a falhar
        //    ou a mudares de banda). O que prova que saíste é a DISTÂNCIA.
        // ---------------------------------------------------------------
        if (distanceM > rearmAt) {
            if (door.armed) {
                door.awaySinceAt = 0L
                return silent(door, "Longe (%.0f m) — armada".format(distanceM))
            }

            // Ligado ao Wi-Fi de casa => estás em casa, ponto final. O GPS pode
            // dizer que estás longe (em prédios o erro chega a dar dezenas de
            // metros), mas o Wi-Fi não engana: o alcance é curto. Enquanto
            // estiveres ligado, NÃO deixamos armar — assim a porta nunca pode
            // disparar por o GPS ter delirado enquanto estás no sofá.
            //
            // Repara que isto trava o ARMAR, não o abrir. Bloquear a abertura
            // seria muito pior: ao chegar a casa o telemóvel apanha o Wi-Fi
            // ainda na rua e a porta deixava de abrir, que é o bug original.
            if (wifi.isAtHome(door)) {
                door.awaySinceAt = 0L
                return silent(door, "Longe (%.0f m) mas no Wi-Fi de casa — não arma".format(distanceM))
            }

            // Primeira leitura longe: começa a contar.
            if (door.awaySinceAt == 0L) {
                door.awaySinceAt = now
                return silent(door, "Longe (%.0f m) — a confirmar saída…".format(distanceM))
            }

            val awayFor = (now - door.awaySinceAt) / 1000
            val need = prefs.awayConfirmSeconds
            if (awayFor < need) {
                return silent(door, "Longe (%.0f m) há ${awayFor}s de ${need}s".format(distanceM))
            }

            door.armed = true
            door.lastArmedAt = now
            door.awaySinceAt = 0L
            return silent(door, "Armada ✓ (saíste — a %.0f m)".format(distanceM))
        }

        // Aproximaste-te outra vez: a contagem de "longe" recomeça do zero.
        door.awaySinceAt = 0L

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
            return silent(door, "Perto (%.0f m) · não armada (afasta-te >%.0f m durante %ds)"
                .format(distanceM, rearmAt, prefs.awayConfirmSeconds))
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


    /**
     * Avalia TODAS as condições (não pára na primeira que falha) e devolve o
     * retrato completo, para o ecrã de diagnóstico.
     *
     * Não muta a morada nem abre nada — é só leitura. A decisão real continua
     * a ser tomada por [evaluate].
     */
    fun diagnose(
        door: Door,
        distanceM: Float,
        accuracyM: Float,
        speedMs: Float,
        source: String = "gps"
    ): Diagnostics {
        val now = System.currentTimeMillis()
        val c = ArrayList<Condition>()
        val radius = door.radiusM
        val rearmAt = radius + prefs.rearmMarginM

        // 1) Automação ligada
        c.add(
            Condition(
                "Automação ligada",
                if (prefs.autoEnabled) Condition.State.OK else Condition.State.BLOCKED,
                if (prefs.autoEnabled) "ligada" else "desligada",
                "ligada",
                "Liga no botão do ecrã principal."
            )
        )

        // 2) Morada ativa
        c.add(
            Condition(
                "Morada ativa",
                if (door.enabled) Condition.State.OK else Condition.State.BLOCKED,
                if (door.enabled) "sim" else "não",
                "sim",
                "Ativa o interruptor no topo das definições desta morada."
            )
        )

        // 3) Ponto definido
        c.add(
            Condition(
                "Ponto da porta",
                if (door.hasPoint()) Condition.State.OK else Condition.State.BLOCKED,
                if (door.hasPoint()) "definido" else "em falta",
                "definido",
                "Marca a porta no mapa nas definições desta morada."
            )
        )

        if (!door.hasPoint()) {
            return Diagnostics(now, c, "Falta marcar o ponto da porta", false, -1f, accuracyM, speedMs, source)
        }

        // 4) Sinal de GPS
        c.add(
            Condition(
                "Sinal de GPS",
                when {
                    accuracyM <= 0f -> Condition.State.UNKNOWN
                    accuracyM > prefs.minAccuracyM -> Condition.State.BLOCKED
                    else -> Condition.State.OK
                },
                if (accuracyM > 0f) "±%.0f m".format(accuracyM) else "desconhecido",
                "melhor que ±%.0f m".format(prefs.minAccuracyM),
                "Ao ar livre o sinal melhora. Se acontecer sempre, sobe a precisão mínima."
            )
        )

        // 5) ARMADA — a condição que costuma faltar
        val awayFor = if (door.awaySinceAt > 0L) (now - door.awaySinceAt) / 1000 else 0L
        val atHomeNow = wifi.isAtHome(door)
        c.add(
            Condition(
                "Armada (já saíste)",
                if (door.armed) Condition.State.OK else Condition.State.BLOCKED,
                when {
                    door.armed -> "sim"
                    atHomeNow -> "não · estás no Wi-Fi de casa"
                    door.awaySinceAt > 0L -> "não · longe há ${awayFor}s de ${prefs.awayConfirmSeconds}s"
                    distanceM > rearmAt -> "não · a contar a partir de agora"
                    else -> "não · estás a %.0f m (é preciso passar dos %.0f m)".format(distanceM, rearmAt)
                },
                "afasta-te >%.0f m durante %ds".format(rearmAt, prefs.awayConfirmSeconds),
                "Só arma depois de te afastares mesmo. Para testar aqui, usa \"Armar esta morada agora\". " +
                    "Para mudar estes números: Definições › Aproximação › \"Margem de rearme (metros)\" " +
                    "(agora %.0f) e \"Tempo longe para armar (segundos)\" (agora %d).".format(
                        prefs.rearmMarginM, prefs.awayConfirmSeconds
                    )
            )
        )

        // 6) Distância
        c.add(
            Condition(
                "Distância à porta",
                if (distanceM <= radius) Condition.State.OK else Condition.State.BLOCKED,
                "a %.0f m".format(distanceM),
                "≤ %.0f m".format(radius),
                "Aproxima-te da porta, ou aumenta o raio desta morada."
            )
        )

        // 7) Velocidade
        c.add(
            Condition(
                "Velocidade",
                when {
                    speedMs < 0f -> Condition.State.UNKNOWN
                    speedMs > prefs.maxSpeedMs -> Condition.State.BLOCKED
                    else -> Condition.State.OK
                },
                if (speedMs >= 0f) "%.1f m/s".format(speedMs) else "desconhecida (não bloqueia)",
                "≤ %.1f m/s".format(prefs.maxSpeedMs),
                "Estás a ir depressa demais — a app pensa que vais de carro."
            )
        )

        // 8) Pausa
        val pausedGlobal = prefs.isPaused()
        val pausedDoor = door.isPaused()
        c.add(
            Condition(
                "Sem pausa",
                if (pausedGlobal || pausedDoor) Condition.State.BLOCKED else Condition.State.OK,
                when {
                    pausedGlobal -> "em pausa global (${prefs.pauseRemainingMillis() / 1000}s)"
                    pausedDoor -> "morada em pausa (${(door.pauseUntil - now) / 1000}s)"
                    else -> "sem pausa"
                },
                "sem pausa",
                "Cancela a pausa no ecrã principal."
            )
        )

        // 9) Cooldown
        val since = if (door.lastOpenAt > 0L) (now - door.lastOpenAt) / 1000 else -1L
        val inCooldown = door.lastOpenAt > 0L && (now - door.lastOpenAt) < prefs.cooldownMs
        c.add(
            Condition(
                "Cooldown",
                if (inCooldown) Condition.State.BLOCKED else Condition.State.OK,
                if (since >= 0) "última abertura há ${since}s" else "nunca abriu",
                "> ${prefs.cooldownMs / 1000}s desde a última",
                "Espera um pouco antes de tentar outra vez."
            )
        )

        // 10) Wi-Fi (só é condição se estiver ligada a opção)
        val atHome = wifi.isAtHome(door)
        c.add(
            if (!prefs.wifiBlocksWhenArmed) {
                Condition(
                    "Wi-Fi de casa",
                    Condition.State.NOT_APPLICABLE,
                    if (atHome) "ligado — impede armar (estás em casa)" else "fora de casa",
                    "não bloqueia a abertura",
                    if (atHome)
                        "Enquanto estiveres no Wi-Fi de casa a morada não arma, " +
                            "por isso a porta não pode disparar. A abrir, não bloqueia nada."
                    else ""
                )
            } else {
                Condition(
                    "Wi-Fi de casa",
                    if (atHome) Condition.State.BLOCKED else Condition.State.OK,
                    if (atHome) "ligado ao Wi-Fi de casa" else "fora de casa",
                    "fora do Wi-Fi de casa",
                    "Desliga a opção \"Wi-Fi bloqueia mesmo depois de saíres\" nas definições globais."
                )
            }
        )

        val blocking = c.filter { it.state == Condition.State.BLOCKED }
        val verdict = when {
            blocking.isEmpty() -> "Tudo pronto — a porta abre à chegada ✓"
            blocking.size == 1 -> "Falta 1 condição: ${blocking[0].name}"
            else -> "Faltam ${blocking.size} condições: ${blocking.joinToString(", ") { it.name }}"
        }

        return Diagnostics(
            at = now, conditions = c, verdict = verdict,
            wouldOpen = blocking.isEmpty(),
            distanceM = distanceM, accuracyM = accuracyM, speedMs = speedMs, source = source
        )
    }

    /** Devolve a morada ao estado armado (para testar no local). */
    fun forceArm(door: Door) {
        door.armed = true
        door.lastArmedAt = System.currentTimeMillis()
        door.awaySinceAt = 0L
        door.lastOpenAt = 0L
        door.pauseUntil = 0L
        door.lastReason = "Armada à mão ✓"
    }

    /** Marca a morada como aberta: desarma, grava timestamps e a pausa opcional. */
    fun markOpened(door: Door) {
        val now = System.currentTimeMillis()
        door.armed = false
        door.awaySinceAt = 0L
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
