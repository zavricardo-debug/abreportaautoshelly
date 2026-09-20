# Controlo do Shelly — código e protocolo

Ficheiro autónomo para exportar/partilhar. Contém tudo o que é preciso para
falar com o relé Shelly, sem depender do resto da app.

**Não contém segredos.** A `auth_key` e o `device id` são escritos pelo
utilizador nas definições da app e ficam no armazenamento do telemóvel.
Se partilhares logs ou capturas de ecrã, tapa esses dois valores.

---

## 1. Protocolo

A app suporta dois modos, escolhidos por morada no campo `controlMode`.

### Modo `cloud` (o que está a ser usado)

```
POST {cloudHost}/device/relay/control
Content-Type: application/x-www-form-urlencoded

channel=0
turn=on
timer=1          # opcional: desliga sozinho ao fim de N segundos
id={deviceId}
auth_key={authKey}
```

- `cloudHost` — por exemplo `https://shelly-37-eu.shelly.cloud`
  (o servidor certo aparece na app Shelly, em *User settings → Authorization cloud key*).
- `timer` é o que faz o **pulso**: liga o relé e desliga-o sozinho passados
  N segundos. É a forma correta de simular um toque na campainha/trinco —
  não é preciso enviar um `off` a seguir.
- Resposta esperada: JSON com `isok: true`, à cabeça ou dentro de `data`.
- `401` significa auth key inválida.

### Modo `local` (mesma rede Wi-Fi do Shelly)

```
GET http://{ip}/relay/{channel}?turn=on
   ... esperar relayPulseSeconds ...
GET http://{ip}/relay/{channel}?turn=off
```

Aqui o pulso é feito à mão: liga, espera, desliga. Só funciona quando o
telemóvel está na mesma rede local do Shelly.

> Nota: este é o formato da **1.ª geração** (Shelly Gen1). Dispositivos Gen2+
> (Plus/Pro) usam RPC — `GET /rpc/Switch.Set?id=0&on=true&toggle_after=1`.
> Se mudares de equipamento, é só o modo local que precisa de ser adaptado.

---

## 2. Testar sem a app (curl)

```bash
curl -X POST https://shelly-37-eu.shelly.cloud/device/relay/control \
  -d channel=0 \
  -d turn=on \
  -d timer=1 \
  -d id=SEU_DEVICE_ID \
  -d auth_key=SUA_AUTH_KEY
```

Se isto abrir a porta, o problema de qualquer falha está no GPS/lógica da app,
não no Shelly. É o teste que separa os dois mundos.

---

## 3. Parâmetros por morada

| Campo | Exemplo | Para que serve |
|---|---|---|
| `controlMode` | `cloud` \| `local` | Qual dos dois protocolos usar |
| `cloudHost` | `https://shelly-37-eu.shelly.cloud` | Servidor da cloud Shelly |
| `cloudDeviceId` | `441793a5621c` | ID do dispositivo |
| `cloudAuthKey` | *(vazio → usa a global)* | Chave de autorização |
| `shellIp` | `192.168.1.100` | IP do Shelly, no modo local |
| `channel` | `0` | Canal do relé |
| `relayPulseSeconds` | `1` | Duração do impulso |

A auth key pode ser definida **por morada** ou **global**. Se o campo da
morada estiver vazio, usa-se a global — é o que `authKeyFor()` faz.

---

## 4. Dependência

```kotlin
implementation("com.squareup.okhttp3:okhttp:4.12.0")
```

---

## 5. Código (Kotlin, Android)

Depende apenas de: `okhttp3`, `org.json`, `android.util.Log`, e de duas classes
da app — `Door` (os campos da tabela acima) e `Prefs` (a auth key global e o
registo do último resultado). Para reutilizar noutro projeto, troca esses dois
por parâmetros simples.

```kotlin
package com.example.shellydoor

import android.util.Log
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Controlador do Shelly — API HTTP do Shelly Cloud (2.ª geração) ou local.
 *
 *   POST {host}/device/relay/control  → channel, turn=on, [timer], id, auth_key
 *
 * O pulso usa o parâmetro `timer`: liga o relé e desliga-o sozinho após N segundos.
 *
 * Correções face à versão anterior:
 *  - **Executor partilhado** em vez de um `CoroutineScope` novo por instância
 *    (criava-se um scope por evento e nunca era cancelado).
 *  - **Retry**: à porta do prédio a rede móvel está muitas vezes a mudar de
 *    célula; uma única tentativa falhava e a porta não abria. Agora tenta 3x.
 *  - **Mensagens de erro reais** (código HTTP / motivo), em vez de "Falha ao
 *    ligar o relé", que não dizia nada sobre o que correu mal.
 */
class ShellyController(private val prefs: Prefs) {

    /** Envia o impulso de abertura. [onResult] é chamado num thread de fundo. */
    fun openDoor(door: Door, onResult: (Boolean, String) -> Unit) {
        executor.execute {
            var lastError = "desconhecido"
            repeat(MAX_ATTEMPTS) { attempt ->
                try {
                    val result = if (door.controlMode.equals("cloud", ignoreCase = true)) {
                        controlRelay(door, "on", door.relayPulseSeconds)
                    } else {
                        pulseLocal(door)
                    }

                    if (result.ok) {
                        prefs.lastOpenTimestamp = System.currentTimeMillis()
                        prefs.lastResult = "Porta aberta ✓ (${door.name})"
                        onResult(true, "Porta aberta ✓")
                        return@execute
                    }
                    lastError = result.message
                    Log.w(TAG, "Tentativa ${attempt + 1}/$MAX_ATTEMPTS falhou: $lastError")
                } catch (e: Exception) {
                    lastError = e.message ?: e.javaClass.simpleName
                    Log.e(TAG, "Tentativa ${attempt + 1}/$MAX_ATTEMPTS erro: $lastError", e)
                }
                if (attempt < MAX_ATTEMPTS - 1) {
                    try { Thread.sleep(RETRY_DELAY_MS) } catch (ie: InterruptedException) { return@execute }
                }
            }
            prefs.lastResult = "Não abriu (${door.name}): $lastError"
            onResult(false, lastError)
        }
    }

    /** Auth key a usar para uma morada: a dela se existir, senão a global. */
    private fun authKeyFor(door: Door): String {
        val local = door.cloudAuthKey.trim()
        return local.ifEmpty { prefs.cloudAuthKeyGlobal.trim() }
    }

    private data class CallResult(val ok: Boolean, val message: String)

    private fun controlRelay(door: Door, turn: String, timerSeconds: Int): CallResult {
        val key = authKeyFor(door)
        if (key.isEmpty()) return CallResult(false, "sem auth key (Definições globais)")
        if (door.cloudDeviceId.isBlank()) return CallResult(false, "sem device ID")

        val form = FormBody.Builder()
            .add("channel", door.channel.toString())
            .add("turn", turn)
            .add("id", door.cloudDeviceId)
            .add("auth_key", key)
        if (timerSeconds > 0) form.add("timer", timerSeconds.toString())

        val host = door.cloudHost.trim().trimEnd('/').let {
            if (it.startsWith("http")) it else "https://$it"
        }
        val url = "$host/device/relay/control"
        return execJson(Request.Builder().url(url).post(form.build()).build())
    }

    /** Modo local: liga, espera o impulso, desliga. */
    private fun pulseLocal(door: Door): CallResult {
        val on = controlRelayLocal(door, "on")
        if (!on.ok) return on
        try { Thread.sleep(door.relayPulseSeconds.coerceIn(1, 10) * 1000L) } catch (e: InterruptedException) { }
        controlRelayLocal(door, "off")
        return CallResult(true, "ok")
    }

    private fun controlRelayLocal(door: Door, turn: String): CallResult {
        if (door.shellIp.isBlank()) return CallResult(false, "sem IP do Shelly")
        val url = "http://${door.shellIp.trim()}/relay/${door.channel}?turn=$turn"
        return try {
            client.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (resp.isSuccessful) CallResult(true, "ok")
                else CallResult(false, "HTTP ${resp.code} (local)")
            }
        } catch (e: Exception) {
            CallResult(false, "rede local: ${e.message}")
        }
    }

    private fun execJson(request: Request): CallResult {
        client.newCall(request).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            Log.d(TAG, "HTTP ${resp.code} $body")

            if (resp.code == 401) return CallResult(false, "auth key inválida (401)")
            if (!resp.isSuccessful) return CallResult(false, "HTTP ${resp.code}")

            return try {
                val obj = JSONObject(body)
                val ok = obj.optBoolean("isok", false) ||
                        obj.optJSONObject("data")?.optBoolean("isok", false) == true
                if (ok) CallResult(true, "ok")
                else CallResult(false, obj.optString("errors", body.take(120)).ifBlank { "resposta sem isok" })
            } catch (e: Exception) {
                // Alguns firmwares devolvem texto simples num 200.
                if (resp.isSuccessful) CallResult(true, "ok") else CallResult(false, "resposta inválida")
            }
        }
    }

    companion object {
        private const val TAG = "ShellyController"
        private const val MAX_ATTEMPTS = 3
        private const val RETRY_DELAY_MS = 900L

        /** Cliente e executor partilhados por toda a app (poupa sockets e threads). */
        private val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .writeTimeout(8, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        private val executor = Executors.newFixedThreadPool(2) { r ->
            Thread(r, "shelly-io").apply { isDaemon = true }
        }
    }
}
```

---

## 6. Decisões que interessam a quem for continuar isto

- **3 tentativas com 900 ms de intervalo.** À porta do prédio o telemóvel está
  muitas vezes a trocar de célula; uma tentativa única falhava e a porta não
  abria. Este retry resolveu falhas reais.
- **Timeouts curtos** (6 s a ligar, 8 s a ler). Uma chamada pendurada 30 s não
  serve para nada — a essa altura já se está à porta há muito tempo.
- **Cliente OkHttp e executor `static`.** A versão anterior criava um scope
  novo por evento e nunca o cancelava.
- **Erros com o motivo real** (código HTTP, `401`, texto da resposta) em vez de
  uma mensagem genérica — foi o que permitiu perceber que era a auth key.
- **Fallback de resposta:** se o corpo não for JSON válido mas o HTTP for 200,
  considera-se sucesso; alguns firmwares respondem texto simples.
