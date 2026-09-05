# 🚪 ShellyDoor — Abertura automática da porta do prédio

App Android (Kotlin) que abre a porta quando te aproximas do prédio, usando o teu
**Shelly** com relé, com **sensibilidade** para **não abrir enquanto estás em casa**.

> **Multi-moradas:** a app suporta **várias moradas independentes** — cada uma com o
> seu **nome**, as suas coordenadas, o seu raio, o seu Wi-Fi de casa e o seu **próprio
> Shelly**. Configura-as todas a partir do ecrã principal (botão **➕ Adicionar morada**).

## Como funciona (a lógica de decisão)

> **⚠ Mudança importante (correção do "não abre quando estou à frente da porta").**
> Antes, a decisão dependia de **não** estares ligado ao Wi-Fi de casa no momento
> da chegada. Só que o telemóvel apanha a rede de casa **ainda na rua**, a 20–40 m
> da porta — ou seja, o kill-switch disparava exatamente quando devias entrar.
> Agora a app usa um modelo de **armar / disparar**, explicado a seguir.

### Armar ao sair, disparar ao chegar

Cada morada tem um estado interno: **armada** ou **não armada**.

| Estado | Quando acontece | A porta abre ao chegar? |
|---|---|---|
| **Não armada** | Estás em casa, ou nunca te afastaste | ❌ Não |
| **Armada** 🟢 | Afastaste-te mais do que `raio + margem de rearme` (por defeito 35 + 60 = 95 m) **e** já não estavas no Wi-Fi de casa | ✅ Sim |

A porta abre **automaticamente** quando:

1. A morada está **armada** (ou seja: saíste mesmo de casa).
2. **Entras no raio** da porta (por defeito 35 m).
3. Não vais **demasiado depressa** (por defeito >8 m/s ≈ 29 km/h bloqueia — a pé
   nunca bloqueia; velocidade desconhecida também não bloqueia).
4. O **GPS não está absurdamente impreciso** (pior que ±120 m).
5. Não está em **pausa** e o **cooldown** dessa morada já passou.

Ao abrir, a morada **desarma** — só volta a abrir depois de te afastares outra vez.
É isto que impede a porta de reabrir enquanto ficas à conversa à entrada, sem
precisar de bloquear nada durante 10 minutos.

```
Estou em casa ─────────────────────────► não armada ──► nunca abre
     │
     └─ saio, afasto-me >95 m, sem Wi-Fi de casa ──► 🟢 ARMADA
                                                        │
                                       volto e entro no raio (35 m)
                                                        │
                                    devagar? GPS ok? sem cooldown?
                                                        │ sim
                                                        ▼
                                     Shelly: impulso → porta abre → desarma
```

### E o Wi-Fi de casa, para que serve agora?

Continua a ser o guarda que impede a morada de **armar** enquanto estás em casa
(incluindo o *grace period* de 60 s para a troca 5G↔2.4G). O que mudou é que ele
já **não bloqueia a chegada**: depois de teres saído a sério, chegar à porta abre,
esteja o telemóvel já ligado ao Wi-Fi de casa ou não.

> Se preferires o comportamento antigo, liga **"Wi-Fi de casa bloqueia mesmo depois
> de teres saído"** em ⚙ Definições globais (não é recomendado — era a causa do
> problema).

### Rastreio ativo (a outra metade da correção)

Os **geofences do Android**, sozinhos, são lentos e pouco fiáveis com raios
pequenos: muitas vezes o evento de entrada só chega minutos depois — ou nunca,
com o ecrã desligado. Era a segunda razão de "estou à porta e não acontece nada".

Agora o serviço em foreground faz **rastreio ativo de localização**, com ritmo
adaptativo:

| Situação | Frequência do GPS |
|---|---|
| A mais de 400 m de qualquer morada | a cada **45 s** (poupa bateria) |
| A menos de 400 m de uma morada | a cada **4 s** (deteta a chegada em segundos) |

Os geofences continuam registados como **rede de segurança** (com raio mínimo de
100 m, que é o que o Android consegue mesmo detetar) e, quando disparam, apenas
acordam o serviço — quem decide é sempre a distância real.

## ⏸ Pausa (para não abrir sempre que estás à conversa à porta)

Se ficas a conversar perto da entrada, a porta não deve abrir de cada vez. A app tem
dois mecanismos:

- **Rearme por distância** (é o mecanismo principal, sempre ativo): depois de abrir,
  a morada **desarma** e só volta a armar quando te afastares >95 m. Ficares à
  conversa à porta nunca reabre nada.
- **Auto-pausa após abertura** (agora **desligada** por defeito — o rearme já
  resolve o problema, e a pausa antiga silenciava também as outras moradas).
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

## ✅ Depois de instalar: as 3 coisas que TÊM de estar certas

Se a porta não abrir à chegada, é quase sempre uma destas (não é o código):

1. **Localização = "Permitir sempre"**
   Definições → Apps → ShellyDoor → Permissões → Localização → **Permitir sempre**
   (+ "Usar localização precisa"). Só com "enquanto a app está aberta" o Android
   corta o rastreio assim que bloqueias o ecrã. A app pede-te isto no arranque.
2. **Bateria sem restrições**
   ⚙ Definições globais → **🔋 Desativar otimização de bateria**. Em Xiaomi/Huawei/
   Oppo/Samsung é preciso ainda "Início automático" / "Não otimizar" no menu do
   fabricante, senão o sistema mata o serviço passado uns minutos.
3. **Cada morada com o ponto marcado** (🗺 mapa) e o **SSID de casa** preenchido.

O ecrã principal mostra avisos ⚠ quando algo destes falta, e por baixo de cada
morada mostra **a distância atual e o motivo** da última decisão — é por aí que se
percebe o que está a acontecer.

### Testar sem sair de casa
⚙ Definições globais → **🔄 Armar todas as moradas agora**. Isto força o estado
"armada"; a próxima vez que a app te vir dentro do raio, abre.

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

### Opção A — descarregar o APK já compilado (mais rápido, sem instalar nada)

O repositório tem um workflow de GitHub Actions (`.github/workflows/android-build.yml`)
que compila a app a cada push e publica o APK.

1. Vai a **Actions → Build APK** no GitHub e abre a execução mais recente
   (✓ verde) desta branch.
2. Em baixo, na secção **Artifacts**, descarrega **`ShellyDoor-debug-apk`**.
3. Descompacta o `.zip` e passa o `app-debug.apk` para o telemóvel.
4. Abre-o no telemóvel e aceita **"instalar de fontes desconhecidas"**.

> Usa a versão **debug**: já vem assinada com a chave de debug e instala
> diretamente. A `release` é gerada sem assinatura, por isso o Android recusa-a
> a menos que a assines primeiro.

### Opção B — compilar no Android Studio

1. Abre a pasta `ShellyDoor/` no **Android Studio**.
2. Deixa o Gradle sincronizar (descarrega as dependências).
3. Liga o telemóvel (com **Debug USB**) e corre com ▶ Run, ou gera um APK:
   `Build → Build APK(s)`.
4. Instala o `app-debug.apk` no teu telemóvel.

> Se atualizares por cima de uma instalação antiga, as moradas e definições
> são mantidas. Depois de instalar, confirma as permissões da secção
> **"as 3 coisas que TÊM de estar certas"** acima.

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
| **Não abre ao chegar** | Vê o diagnóstico no ecrã principal (mostra a distância e o motivo). Confirma que diz **🟢 armada**; se não, é porque a app não percebeu que saíste — reduz a *margem de rearme*. Confirma também a localização em **"Permitir sempre"** e a **bateria sem restrições**. |
| Só abre às vezes / abre tarde | Otimização de bateria. ⚙ Definições globais → **🔋 Desativar otimização de bateria**. |
| Abre dentro do apartamento | Não devia acontecer (nunca arma em casa). Confirma que o **SSID de casa** está certo na morada e aumenta a **margem de rearme**. |
| Abre quando passo de carro | Reduz **Velocidade máx** (ex.: 4–5 m/s). |
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
│  ├─ DoorService.kt           # ★ foreground + rastreio ativo de localização
│  ├─ GeofenceManager.kt       # registo de UM geofence por morada
│  ├─ DoorGeofenceReceiver.kt  # identifica a morada e aplica a decisão
│  ├─ DoorDecisionEngine.kt    # ★ decisão: armar ao sair / disparar ao chegar
│  ├─ ApproachEvaluator.kt     # ★ ponto único de avaliação (rastreio + geofence)
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
