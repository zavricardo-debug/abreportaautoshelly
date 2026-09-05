package com.example.shellydoor

import android.content.Context
import org.json.JSONArray

/**
 * Guarda a lista de portas (moradas) como JSON em SharedPreferences.
 * Cada porta ocupa o seu próprio geofence e Shelly.
 */
class DoorStore(context: Context) {

    private val sp = context.getSharedPreferences("shellydoor_doors", Context.MODE_PRIVATE)
    private val key = "doors"

    fun all(): List<Door> {
        val raw = sp.getString(key, "[]") ?: "[]"
        val arr = JSONArray(raw)
        val list = ArrayList<Door>(arr.length())
        for (i in 0 until arr.length()) list.add(Door.fromJson(arr.getJSONObject(i)))
        return list
    }

    private fun save(list: List<Door>) {
        val arr = JSONArray()
        list.forEach { arr.put(it.toJson()) }
        sp.edit().putString(key, arr.toString()).apply()
    }

    fun add(door: Door) = save(all() + door)
    fun update(updated: Door) = save(all().map { if (it.id == updated.id) updated else it })
    fun updateAll(list: List<Door>) = save(list)
    fun remove(id: String) = save(all().filter { it.id != id })
    fun byId(id: String): Door? = all().firstOrNull { it.id == id }

    /** Cria uma porta nova com um nome incremental e guarda-a. */
    fun newDoor(): Door {
        val n = all().size + 1
        val door = Door(name = "Morada $n")
        add(door)
        return door
    }

    /**
     * Cria as moradas por defeito (só no 1.º arranque, controlado por um flag).
     * "Ladra" vem preenchido com o Shelly que já conhecemos (o do abrir.html);
     * "Alvalade" e "Argandona" ficam com o nome pronto e o resto por preencher.
     */
    fun seedIfNeeded() {
        if (sp.getBoolean(SEEDED_KEY, false)) return
        val ladra = Door(
            name = "Ladra",
            lat = 0.0, lng = 0.0,
            controlMode = "cloud",
            cloudHost = "https://shelly-37-eu.shelly.cloud",
            cloudDeviceId = "441793a5621c",
            cloudAuthKey = DEFAULT_AUTH_KEY,
            channel = 0,
            relayPulseSeconds = 1
        )
        val alvalade = Door(
            name = "Alvalade",
            lat = 0.0, lng = 0.0,
            controlMode = "cloud",
            cloudHost = "https://shelly-37-eu.shelly.cloud",
            cloudDeviceId = "7c87ce576a8c",
            cloudAuthKey = DEFAULT_AUTH_KEY,
            channel = 0,
            relayPulseSeconds = 1
        )
        val argandona = Door(
            name = "Argandona",
            lat = 0.0, lng = 0.0,
            controlMode = "cloud",
            cloudHost = "https://shelly-37-eu.shelly.cloud",
            cloudDeviceId = "7c87ce56409c",
            cloudAuthKey = DEFAULT_AUTH_KEY,
            channel = 0,
            relayPulseSeconds = 1
        )
        save(listOf(ladra, alvalade, argandona))
        sp.edit().putBoolean(SEEDED_KEY, true).apply()
    }

    companion object {
        private const val SEEDED_KEY = "seeded_v2"

        /**
         * Auth key da conta de nuvem do utilizador (gerado após mudar a password).
         * É aplicado às 3 moradas no seed; cada uma pode ser alterada individualmente
         * no seu ecrã de configuração (campo "Auth key").
         */
        const val DEFAULT_AUTH_KEY =
            "ZjJmMGF1aWQE3BBDBB3C3994FEF570BD05536F0B61870FB50B13330B538CCC3CD1CED73B48DE08857F206F86FFF"
    }
}
