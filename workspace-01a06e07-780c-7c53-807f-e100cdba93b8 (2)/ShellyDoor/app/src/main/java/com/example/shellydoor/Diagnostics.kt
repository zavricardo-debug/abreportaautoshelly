package com.example.shellydoor

import org.json.JSONArray
import org.json.JSONObject

/**
 * Estado de UMA condição necessária para a porta abrir.
 *
 * O motor de decisão pára na primeira condição que falha (é o correto para
 * decidir), mas para diagnosticar precisamos do contrário: saber o estado de
 * **todas** as condições ao mesmo tempo — as que já estão cumpridas e as que
 * faltam. É para isso que serve esta classe.
 */
data class Condition(
    /** Nome curto, ex.: "Distância". */
    val name: String,
    /** Estado atual. */
    val state: State,
    /** Valor medido agora, ex.: "a 18 m". */
    val actual: String,
    /** O que é preciso para passar, ex.: "≤ 30 m". */
    val needed: String,
    /** Explicação/como resolver, quando está bloqueada. */
    val hint: String = ""
) {
    enum class State { OK, BLOCKED, UNKNOWN, NOT_APPLICABLE }

    val icon: String
        get() = when (state) {
            State.OK -> "✅"
            State.BLOCKED -> "❌"
            State.UNKNOWN -> "❔"
            State.NOT_APPLICABLE -> "➖"
        }

    fun toJson(): JSONObject = JSONObject().apply {
        put("name", name); put("state", state.name)
        put("actual", actual); put("needed", needed); put("hint", hint)
    }

    companion object {
        fun fromJson(o: JSONObject) = Condition(
            name = o.optString("name"),
            state = runCatching { State.valueOf(o.optString("state", "UNKNOWN")) }
                .getOrDefault(State.UNKNOWN),
            actual = o.optString("actual"),
            needed = o.optString("needed"),
            hint = o.optString("hint")
        )
    }
}

/**
 * Fotografia completa da última avaliação de uma morada: todas as condições,
 * o veredicto e os números crus (distância, precisão, velocidade).
 *
 * É guardada em [Door.lastDiagnostics] a cada leitura de GPS, para o ecrã de
 * diagnóstico poder mostrar, ao vivo e no local, o que está a passar e o que
 * está a faltar.
 */
data class Diagnostics(
    val at: Long = 0L,
    val conditions: List<Condition> = emptyList(),
    val verdict: String = "",
    val wouldOpen: Boolean = false,
    val distanceM: Float = -1f,
    val accuracyM: Float = -1f,
    val speedMs: Float = -1f,
    val source: String = ""
) {
    /** Condições que faltam cumprir (as que impedem a porta de abrir). */
    fun blocking(): List<Condition> = conditions.filter { it.state == Condition.State.BLOCKED }

    fun toJson(): JSONObject = JSONObject().apply {
        put("at", at); put("verdict", verdict); put("wouldOpen", wouldOpen)
        put("distanceM", distanceM.toDouble()); put("accuracyM", accuracyM.toDouble())
        put("speedMs", speedMs.toDouble()); put("source", source)
        put("conditions", JSONArray().also { arr -> conditions.forEach { arr.put(it.toJson()) } })
    }

    companion object {
        fun fromJson(o: JSONObject): Diagnostics {
            val arr = o.optJSONArray("conditions") ?: JSONArray()
            val list = ArrayList<Condition>(arr.length())
            for (i in 0 until arr.length()) list.add(Condition.fromJson(arr.getJSONObject(i)))
            return Diagnostics(
                at = o.optLong("at", 0L),
                conditions = list,
                verdict = o.optString("verdict"),
                wouldOpen = o.optBoolean("wouldOpen", false),
                distanceM = o.optDouble("distanceM", -1.0).toFloat(),
                accuracyM = o.optDouble("accuracyM", -1.0).toFloat(),
                speedMs = o.optDouble("speedMs", -1.0).toFloat(),
                source = o.optString("source")
            )
        }

        fun fromJsonOrNull(raw: String?): Diagnostics? {
            if (raw.isNullOrBlank()) return null
            return runCatching { fromJson(JSONObject(raw)) }.getOrNull()
        }
    }
}
