package com.example.shellydoor

/**
 * Motor de decisão — a "sensibilidade". Opera sobre uma [Door] concreta.
 *
 * A porta SÓ abre automaticamente se TODAS as condições forem verdadeiras:
 *   1. Evento de ENTRADA no cerco daquela morada.
 *   2. Velocidade baixa (não a passar de carro).
 *   3. Não estamos ligados ao Wi-Fi de casa daquela morada.
 *   4. Não estamos em pausa e respeitamos o cooldown global.
 */
class DoorDecisionEngine(private val prefs: Prefs, private val wifi: WifiHomeChecker) {

    sealed class Outcome {
        data object AllowOpen : Outcome()
        data class Denied(val reason: String) : Outcome()
    }

    fun evaluate(door: Door, entered: Boolean, speedMs: Float): Outcome {
        if (!entered) return Outcome.Denied("Evento não é de entrada")

        if (prefs.isPaused()) {
            val rest = prefs.pauseRemainingMillis() / 1000
            return Outcome.Denied("Automação em pausa (${rest}s restantes)")
        }

        if (speedMs > prefs.maxSpeedMs) {
            return Outcome.Denied("Velocidade demasiado alta (${speedMs} m/s)")
        }

        if (wifi.isAtHome(door)) {
            return Outcome.Denied("Ligado ao Wi-Fi de ${door.name}")
        }

        val sinceLast = System.currentTimeMillis() - prefs.lastOpenTimestamp
        if (sinceLast < prefs.cooldownMs) {
            return Outcome.Denied("Cooldown ativo (${sinceLast}ms)")
        }

        return Outcome.AllowOpen
    }
}
