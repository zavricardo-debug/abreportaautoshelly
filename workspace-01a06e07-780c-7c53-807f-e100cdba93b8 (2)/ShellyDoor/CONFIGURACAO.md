# 🎛 Legend — what every configuration number does

Every field, in the order it appears on screen, with its default and what happens
when you raise or lower it.

**Two separate screens:**

- **⚙ Definições globais** — shared by all addresses.
- **Each address** (tap a door → ✏ Editar) — that door only.

---

## ⚙ Definições globais (shared by all addresses)

### 1. `Velocidade máx para abrir (m/s)` — default **8**

Maximum speed at which the door is still allowed to open. Above this, the app
assumes you are driving past rather than arriving.

| Value | Effect |
|---|---|
| Lower (3) | Only opens if you're moving slowly. **Can block you if you arrive briskly or by bike.** |
| **8 (default)** | Walking, running and cycling all open it; a car passing by does not. |
| Higher (15) | Opens even from a moving car. |

> Units are **metres per second**, not km/h. Divide km/h by 3.6:
> walking ≈ 1.4 m/s, running ≈ 3 m/s, city driving ≈ 14 m/s (50 km/h).
> If the phone can't measure speed, this check is **skipped** (never blocks).

### 2. `Cooldown (segundos) entre aberturas` — default **30**

Minimum time before the *same* address can auto-open again. Prevents double
pulses from two GPS readings arriving together. Counted **per address**, so
opening one door doesn't block another.

### 3. `Duração da pausa (minutos)` — default **10**

How long the ⏸ pause lasts. Only affects **automatic** opening — the manual
"Abrir" button always works.

### 4. ☐ `Auto-pausa após cada abertura` — default **OFF**

Pauses automation for the minutes above after every automatic opening. Left off
because the arm/disarm cycle already prevents re-opening while you linger.

### 5. `Delay de troca de rede (segundos)` — default **20**

Grace window after the phone leaves home Wi-Fi, so switching 5 GHz ↔ 2.4 GHz
indoors isn't mistaken for leaving.

> **No longer affects arming.** Arming is now purely distance + time
> (see *Tempo longe para armar*). This value only matters if you switch on
> *"Wi-Fi de casa bloqueia mesmo depois de teres saído"*.

### 6. `Auth key da conta` — no default

Shelly Cloud key shared by all addresses. Used when an address's own key field
is empty.

---

### — Aproximação section —

### 7. ☑ `Rastreio ativo de localização` — default **ON**

Keep this **on**. It's the active GPS tracking that actually detects arrival.
Turning it off leaves only Android's geofences, which are slow and unreliable at
small radii — that was one of the original reasons the door didn't open.

### 8. `Margem de rearme (metros)` — default **25** ⚠️

**The most important number, and the one behind your symptom.** How much further
than the radius you must travel before the address arms.

> **Arming distance = radius + this margin.**
> With the default 30 m radius: 30 + 25 = **55 m away**.

| Value | Effect |
|---|---|
| Lower (15) | Arms after a short walk. Circling the block may re-arm it. |
| **25 (default)** | Reachable on a normal errand. |
| Higher (100) | Only arms on a real trip out. |

### 8b. `Tempo longe para armar (segundos)` — default **60** ⭐ NEW

How long you must stay **continuously** beyond that distance before the address
arms. Together with the margin, this is what separates *"I went out"* from
*"I'm walking past the door on my way to the street"*.

**This is what stops the door opening behind you as you leave.** On the way out
you're still close to the door, so the counter hasn't even started — the address
is not armed and nothing fires. The counter resets to zero the moment you come
back within range.

| Value | Effect |
|---|---|
| 0 | Arms as soon as you're far enough, no waiting. |
| **60 (default)** | A brief errand (bins, car) won't arm it; a real outing will. |
| 300 | Only arms after you've been properly away for 5 minutes. |

### 9. `Precisão mínima do GPS (metros)` — default **120**

Rejects position fixes worse than this. Deliberately generous — between
buildings a phone easily reports ±40–80 m and you're still at the door. Lowering
it to something strict like 20 will **stop the door opening** in a narrow street.

### 10. `Intervalo do GPS perto de casa (segundos)` — default **4**

How often position is checked within 400 m of an address. Lower = detects your
arrival faster, uses more battery.

### 11. `Intervalo do GPS longe de casa (segundos)` — default **45**

How often position is checked when far away. This is the battery-saving mode.

### 12. ☐ `Wi-Fi de casa bloqueia mesmo depois de teres saído` — default **OFF**

Leave **off**. Turning it on restores the original bug: your phone joins the
home Wi-Fi from the street, and the door refuses to open just as you reach it.

### 13. 🔄 `Armar todas as moradas agora` (button)

Forces every address into the armed state immediately, ignoring distance and
Wi-Fi. **Use this to test without walking 70 m away** — press it, then walk to
the door and it should open.

### 14. 🔋 `Desativar otimização de bateria` (button)

Stops Android from killing the tracking service. Without it the app works for a
few minutes and then goes quiet.

---

## 🏠 Per-address settings (tap a door → ✏ Editar)

| Field | Default | What it does |
|---|---|---|
| `Nome da morada` | — | Label only. |
| `Automação desta morada ativa?` | ON | Off = this door never opens automatically. |
| 📌 `Definir porta aqui` | — | Saves your **current** GPS position as the door. Only accurate if you're standing at the door with good signal. |
| 🗺 `Marcar porta no mapa` | — | **Most accurate.** Long-press the exact entrance on the map. |
| `Latitude` / `Longitude` | — | The door's coordinates. Paste from Google Maps if you prefer. |
| `Raio de disparo (metros)` | **30** | How close you must be to trigger. See warning below. |
| `Ligado ao Wi-Fi de casa = bloquear` | ON | Enables the Wi-Fi rule that stops the door arming while you're home. |
| `SSID de casa` | empty | Your home network name(s), comma-separated. **Must match exactly.** If blank, the Wi-Fi rule does nothing. |
| `Modo` | `cloud` | `cloud` (works anywhere) or `local` (same network only). |
| `Canal do relé` | 0 | Usually 0. |
| `IP do Shelly` | 192.168.1.100 | Local mode only. |
| `Host do Shelly Cloud` | shelly-37-eu… | Cloud server. |
| `ID do dispositivo` | per address | Identifies which Shelly to pulse. |
| `Auth key` | per address | Overrides the global key. |
| `Duração do impulso (segundos)` | 1 | How long the relay stays closed — same as holding the button. Raise to 2 if the latch doesn't catch. |
| ⚡ `Testar este Shelly agora` | — | Fires the relay immediately. Confirms wiring and credentials independently of GPS. |

> ### ⚠️ About your 10 m radius
> A 10 m radius is **too tight for GPS**. Phones are typically accurate to
> 10–30 m, and worse between buildings — you can stand at the door and have the
> phone believe you're 25 m away, so the trigger never fires. **20–35 m is the
> realistic minimum.** The radius does not need to exclude your apartment; the
> arm/disarm logic is what keeps it from opening while you're home.

---

## 🔧 Settings for your next test

The new defaults already fix the arming problem (55 m instead of 70 m, and Wi-Fi
no longer blocks arming). **Set the radius back to 30 m** — 10 m is below what
GPS can resolve, so the trigger would never fire even once armed.

| Setting | Value | Why |
|---|---|---|
| `Raio de disparo` | **30** | 10 m is below GPS accuracy |
| `Margem de rearme` | 25 (default) | Arms at ~55 m |
| `Tempo longe para armar` | 60 (default) | Blocks opening on the way out |
| `Intervalo do GPS perto` | 3–4 | Reacts faster on approach |

**Fastest way to test the relay + trigger, without walking anywhere:**

1. ⚙ Definições globais → 🔄 **Armar todas as moradas agora** → Guardar.
2. Check the main screen shows **🟢 armada** under the address.
3. Walk to the door — it should open.

If it still doesn't, the line under the address name on the main screen shows
the live distance and the exact reason for the last decision. Tell me what it
says and that pinpoints which check is refusing.
