# 🚪 ShellyDoor — Abertura automática da porta do prédio

App Android (Kotlin) que abre a porta quando te aproximas do prédio, usando o teu
**Shelly** com relé, com **sensibilidade** para **não abrir enquanto estás em casa**.

> **Multi-moradas:** a app suporta **várias moradas independentes** — cada uma com o
> seu **nome**, as suas coordenadas, o seu raio, o seu Wi-Fi de casa e o seu **próprio
> Shelly**. Configura-as todas a partir do ecrã principal (botão **➕ Adicionar morada**).

## Como funciona (a lógica de decisão)

A porta só abre **automaticamente** quando TODAS as condições são verdadeiras:

1. **GPS** — entras no cerco (geofence) à volta da porta (raio configurável, por
   defeito 35 m). O sistema só dispara na transição de **ENTRADA**, não continuamente.
2. **Velocidade** — estás devagar (não a passar de carro/a correr).
3. **Wi-Fi = kill-switch** — se estás ligado ao teu Wi-Fi de casa, a abertura
   automática é **bloqueada**. Este é o teu principal "não abrir dentro de casa".
4. **Delay de troca de rede (grace period)** — ao mudar de rede dentro de casa
   (5G→2.4G, mudar de router/AP), o SSID fica momentaneamente vazio e a app poderia
   pensar "saí de casa". Para evitar abertura falsa, a app lembra-se de **quando
   estivemos pela última vez num Wi-Fi de casa** e, durante essa janela (60 s por
   defeito), continua a considerar que estamos em casa → **não abre**.
5. **Cooldown** — não repete aberturas num curto intervalo (por defeito 30 s).
6. **Pausa** — se colocaste a automação em pausa (para ficares a conversar à entrada
   sem abrir a porta de cada vez), a automática não dispara enquanto durar a pausa.

Sempre que a automática é bloqueada (ex.: estás em casa), aparece uma notificação
com um **botão manual "Abrir porta"**, para acionares à vontade quando é o caso.

## ⏸ Pausa (para não abrir sempre que estás à conversa à porta)

Se ficas a conversar perto da entrada, a porta não deve abrir de cada vez. A app tem
dois mecanismos:

- **Auto-pausa após abertura** (ligada por defeito): quando a porta abre
  automaticamente, a automação entra em pausa durante X minutos. Assim, se continuares
  por perto (a falar com o vizinho, a esperar), não reabre.
- **Pausa manual** com botão `⏸ Pausar automação` no ecrã principal — para meteres a
  automática em pausa quando quiseres. É cancelável de imediato.

**A pausa nunca bloqueia o botão manual "Abrir porta"** — só a abertura automática.
Define a duração (minutos) em **Definições → "Duração da pausa"** (por defeito 10 min).

```
Approach (GPS) ──► Estou em casa? (Wi-Fi agora OU há <60s) ──► SIM ──► Bloqueia
                          │                                                  (fica o botão manual)
                          └─────► NÃO ──► Velocidade baixa? + Cooldown ok?
                                                  │
                                                  │ sim
                                                  ▼
                                         Shelly: impulso ON → OFF → porta abre
```

> **Nota importante sobre a tua morada:** a porta do prédio e o teu apartamento
> ficam (quase) no mesmo ponto GPS. Por isso o GPS **sozinho** não distingue
> "estou no apartamento" de "estou à entrada". É precisamente para isso que o
> **Wi-Fi de casa** serve: enquanto estás ligado ao router (dentro do prédio), a
> automática está desligada. Quando sais de casa e desligas do Wi-Fi, ao
> aproximares-te o GPS dispara. Ajusta o **raio** (Definições → "Raio de disparo")
> para que o cerco apanhe só a zona da porta, não o teu hall.

---

## Requisitos

- **Android 8.0+** (o telemóvel tem de suportar o Google Play Services / Location).
- Um **Shelly com relé** (ex.: Shelly 1, 1PM, Minis, Plus 1, Pro 1).
- A fechadura/trinco do prédio tem de ser do tipo **elétrico** (os 2 fios do shell
  → relé normal aberto). Se o portão for manual, acopla um motor.
- **Android Studio** (chipmunk ou mais recente) para compilar a app.

---

## 1. Preparar o Shelly

### a) Físico
Liga o relé em paralelo com o botão do prédio (normal aberto). O Shelly faz um
"impulso" (liga ~0,8 s e desliga) — igual a carregar no botão.

### b) Modo LOCAL (dentro da rede — recomendado para começar)
1. Liga o Shelly à tua rede (app Shelly Cloud / web UI).
2. Descobre o **IP** do Shelly (na app Shelly, na tua router, ou em `shelly-<id>.local`).
3. Testa no browser:
   `http://<IP_SHELLY>/relay/0?turn=on`  (deve ligar o relé)
   `http://<IP_SHELLY>/relay/0?turn=off` (desliga)

### c) Modo CLOUD (já configurado para o teu dispositivo)
O `abrir.html` que forneceste corresponde a um **Shelly de 2.ª geração (Plus/Pro)**
acessível via **Shelly Cloud**. A app já vem com esses dados pré-preenchidos:

| Campo | Valor |
|---|---|
| Modo | `cloud` |
| Host | `https://shelly-37-eu.shelly.cloud` |
| ID dispositivo | `441793a5621c` |
| Auth key | (a tua, guardada nas Definições) |
| Canal | `0` |
| Impulso | `1` segundo |

API usada (tal como a tua página):
- `POST {host}/device/relay/control` com `channel`, `turn=on`, **`timer=1`** (o
  dispositivo liga o relé e desliga-o sozinho ao fim de 1 s) + `id` + `auth_key`.
- `POST {host}/device/status` para ler estado/temperatura/Wi-Fi.

Como o pulso é feito pelo próprio parametro `timer`, **não** é preciso enviar um
`off` manual. O botão manual e a automática usam o mesmo impulso.

> O modo `local` (chama o Shelly na rede, `http://<ip>/relay/0?turn=on`) está
> disponível como alternativa e é o que substitui se não quiseres usar a nuvem —
> mas só funciona quando o telemóvel está na mesma rede que o dispositivo. Como o
> teu está no cloud, vem já configurado para disparar de qualquer lado.

---

## 2. Compilar e instalar

1. Abre a pasta `ShellyDoor/` no **Android Studio**.
2. Deixa o Gradle sincronizar (descarrega as dependências).
3. Liga o telemóvel (com **Debug USB**) e corre com ▶ Run, ou gera um APK:
   `Build → Build APK(s)`.
4. Instala o `app-debug.apk` no teu telemóvel.

---

## 3. Configurar a app (cada morada separadamente)

> **☝️ Não precisas de dar a morada. O ponto da porta é um par de coordenadas GPS
> que a app lê no local e que **só fica no teu telemóvel**. Tens 3 formas de o
> registrar.**

| Forma | Como | Quando usar |
|---|---|---|
| **📌 Definir porta aqui** (GPS) | No ecrã da morada, toca no botão. A app grava a tua posição atual. | Boa quando o GPS tem bom sinal à porta. |
| **🗺 Marcar porta no mapa** | Toca e segura no ponto exato da entrada no mapa, confirma. O círculo é o raio. | A mais precisa — escolhes o ponto à rua, não o do GPS "saltitante". |
| **✏ Pois coordenadas** | Colas `lat, lng` do Google Maps (clica direito → copiar coordenadas). | Sem precisar de estar lá / última opção. |

### Moradas pré-criadas
A app já vem com **3 moradas** criadas no primeiro arranque, cada com o seu nome e
**device ID** do respetivo Shelly:

| Morada | Host | Device ID | Auth key |
|---|---|---|---|
| 🏠 **Ladra** | `shelly-37-eu.shelly.cloud` | `441793a5621c` | ✅ preenchido |
| 🏠 **Alvalade** | `shelly-37-eu.shelly.cloud` | `7c87ce576a8c` | ✅ preenchido |
| 🏠 **Argandona** | `shelly-37-eu.shelly.cloud` | `7c87ce56409c` | ✅ preenchido |

> O **auth key** (gerado com a password nova da conta) está pré-preenchido nas **3
> moradas** via `DEFAULT_AUTH_KEY` no `DoorStore`. Se num dispositivo der 401,
> significa que esse Shelly está noutra conta — nesse caso vais buscar o key dessa
> conta e cola-o no campo "Auth key" **da morada específica** (o campo individual tem
> prioridade sobre o global).

O que ainda falta em cada morada (todas as 3): **marcar o ponto** da porta, definir o
**raio** de disparo e o **Wi-Fi de casa** (kill-switch).
> Se apagares todas as moradas, elas **não** voltam a aparecer (o seed só corre no
> 1.º arranque). Usa **➕ Adicionar morada** para criar novas.

### Onde encontrar o auth key (Shelly Cloud)
Se ainda não tens o `auth_key` da conta:
1. Abre a **app Shelly** (ou o painel web: `http://<ip-do-shelly>/`) num dos dispositivos.
2. Definições do dispositivo → secção **Cloud**.
3. O valor do **auth key / cloud key** está aí (ou em **Settings → Security / IP / Cloud**).
4. Cola-o em **Definições globais → "Auth key da conta"**.

### Passos para cada morada

1. No ecrã principal, toca num deles (ex.: Ladra) para editar, ou usa **➕ Adicionar morada**.
2. No ecrã da morada:
   - Dá-lhe um **nome** (ex.: "Casa", "Trabalho").
   - **Marca o ponto da porta** (idealmente pelo mapa — escolhe o ponto exato da entrada,
     e o círculo mostra-te o raio de disparo).
   - Ajusta o **raio**, o **Wi-Fi de casa** (kill-switch) e o **Shelly** desta porta
     (modo, canal, impulso, e os dados do cloud — cada morada tem o seu deviceId/authKey).
   - Toca em **Guardar**.
3. Repete para cada uma das tuas moradas.

### Definições globais (aplicam-se a todas)
O botão **⚙ Definições globais** ajusta velocidade máx, cooldown e pausa — partilhados
por todas as moradas. A **pausa** e o **botão manual** continuam a funcionar por
morada (o manual abre sempre a morada que escolhes).

> **Nota de migração:** se já tinhas uma porta na versão antiga (1.ª versão), os
> dados ficaram em `shellydoor_prefs`. A nova versão guarda tudo em `ShellyDoor_doors`
> (JSON). Volta a definir o ponto e os dados do Shelly por morada.

### 🔁 Delay de troca de rede (evita abrir ao mudar 5G/2.4G em casa)
No ecrã **⚙ Definições globais** tens o campo **"Delay de troca de rede (segundos)"**
(por defeito **60 s**). Durante esse intervalo após a última vez que estiveste num
Wi-Fi de casa, a app **não abre** a porta, mesmo que percas momentaneamente o sinal
do router (ao mudar de banda ou de ponto de acesso). Só depois desse tempo é que a
automação se rearma de verdade.

> O serviço em foreground faz **polling do Wi-Fi a cada 5 s** para manter o
> "última vez em casa" fresco. **O timestamp é guardado POR MORADA** (`Door.lastHomeWifiAt`),
> por isso cada morada tem o seu próprio histórico de rede. Assim, um delay perto de
> uma morada não atrasa o rearne das outras. O **delay** em si é global e configuravel
> em Definições globais.

### 🗺 Preparar o Google Maps (para o seletor no mapa)
O seletor de mapa usa o **Maps SDK for Android**, que precisa de uma chave da Google:
1. Cria uma chave em https://console.cloud.google.com/google/maps-apis
   (ativa o **"Maps SDK for Android"**; opcionalmente restringe o pacote da app).
2. Cola-a em `app/src/main/res/values/api_keys.xml` (campo `google_maps_api_key`), no lugar de
   `YOUR_GOOGLE_MAPS_API_KEY`.
   > Sem a chave, **só o mapa** fica sem fundo — o GPS e as coordenadas manuais
   > continuam a funcionar na perfeição.

## 4. Testar
1. Sai de casa (desliga do Wi-Fi).
2. Caminha em direção à entrada.
3. Ao entrares no cerco GPS (e sem estar ligado ao Wi-Fi de casa), o relé deve
   disparar e a porta abrir. Receberás a notificação "Porta aberta ✓".

---

## Ajuste da sensibilidade (a parte que pediste)

| Problema | Como resolver |
|---|---|
| Abre demasiado cedo / a meio da rua | Reduz o **Raio de disparo** (ex.: 25 m → 15 m). |
| Não abre ao chegar | Aumenta o raio, ou desliga (temporariamente) o kill-switch de Wi-Fi. |
| Abre dentro do apartamento | Aumenta o raio para que o cerco *não* inclua o teu andar... **ou** mantém o Wi-Fi de casa como bloqueador (é o mais fiável). |
| Abre quando passo de carro | Reduz **Velocidade máx** (ex.: 1,5–3 m/s). |
| Abre quando troco de rede em casa (5G/2.4G) | Aumenta o **Delay de troca de rede** (ex.: 60 → 90 s). |
| Abre e fecha de novo | Aumenta a **Duração do impulso** ou o **Cooldown**. |

> **Dica forte:** o Wi-Fi de casa é o teu melhor aliado para "não abrir em casa".
> Mantém a checkbox **"Ligado ao Wi-Fi de casa = bloquear abertura"** ativa e mete
> o SSID da tua rede. Assim, a abertura automática só acontece quando tens
> **certeza** que saíste de casa.

---

## Segurança

- A app só envia o impulso quando há **entrada** no cerco, **devagar**, **fora de
  casa** e **fora do cooldown**. Não abre por "estar lá dentro".
- Tens sempre o **botão manual** na notificação e no ecrã principal.
- O modo **local** é o mais seguro (tráfego só na tua rede). O cloud expõe o
  controlo à Internet — usa se precisares mesmo de fora de casa.
- **Bateria:** o Android gere os geofences a nível do sistema (não é o teu código a
  correr à solta), por isso o consumo é reduzido. Desliga a automação nas
  Definições quando não precisares.

---

## Ficheiros principais

```
ShellyDoor/
├─ app/src/main/java/com/example/shellydoor/
│  ├─ MainActivity.kt          # ecrã principal: lista de moradas + abrir/editar/apagar
│  ├─ DoorSettingsActivity.kt  # config de UMA morada (nome, ponto, raio, Shelly, Wi-Fi)
│  ├─ GlobalSettingsActivity.kt# velocidade, cooldown, pausa (globais)
│  ├─ MapsActivity.kt          # seletor do ponto da porta no mapa (+ círculo do raio)
│  ├─ Door.kt                  # ★ modelo de uma morada (dados + JSON, incl. último Wi-Fi em casa)
│  ├─ DoorStore.kt             # ★ lista de moradas (persistência JSON)
│  ├─ DoorService.kt           # serviço em foreground com geofencing ativo
│  ├─ GeofenceManager.kt       # registo de UM geofence por morada
│  ├─ DoorGeofenceReceiver.kt  # identifica a morada e aplica a decisão
│  ├─ DoorDecisionEngine.kt    # ★ sensibilidade por morada (GPS + Wi-Fi + pausa + cooldown)
│  ├─ WifiHomeChecker.kt       # ★ kill-switch Wi-Fi por morada
│  ├─ ShellyController.kt      # ★ chama o relé da morada (local ou cloud) com impulso
│  ├─ Notifier.kt              # notificações + botão manual (com a morada certa)
│  ├─ Prefs.kt                 # definições globais (velocidade, cooldown, pausa)
│  └─ ...
└─ README.md
```

Personaliza a parte do Shelly (endpoint/geração) em **`ShellyController.kt`** e a
sensibilidade em **`DoorDecisionEngine.kt`** — são os dois pontos desenhados para
serem editados. Boa sorte! 🚪
