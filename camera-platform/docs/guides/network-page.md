# Network Page – Installer Guide

The Network page shows the site's local network as seen from the NVR: one
screen, live measurements only. It never renders a verdict like "good" or
"bad" — only what was measured, or a plain reason when it could not be.

---

## 1. Accessing the page

1. Sign in on the NVR (or a device that can reach it) with an account that
   has the `network.view` permission — the installer role has it; store,
   manager and display accounts do not.
2. Click **Network** in the navigation bar of any other installer page
   (Cameras, Recording, Accounts…), or go directly to `/network-page`.
3. If you don't see a **Network** link, your account lacks `network.view`.

The page polls `GET /network` in the background every few seconds to stay
current — you don't do anything for that.

---

## 2. Interfaces

One card per network card, showing:

| Field | What is shown |
|-------|---------------|
| **Name** | Interface name, and up/down state next to it. |
| **IPv4** | Current address and subnet mask, or "no IPv4 address". |
| **MAC** | Hardware address, or "not reported" if none. |
| **Speed** / **Duplex** | Negotiated speed (Mb/s) and duplex mode. |
| **RX now** / **TX now** | Current receive/transmit rate in Mb/s, plus a 60‑minute strip built from one‑minute samples. |
| **RX/TX errors**, **RX/TX drops** | Counts since the page started sampling. |
| **Cameras here** | The IDs of configured cameras on this interface, or "none". |

If a value can't be measured, the page shows why (for example, a Linux‑only
reading is unavailable). A header line reads "measured since HH:MM" — that's
when this in‑memory history started, not when the interface came up.

---

## 3. Connection checks

The NVR runs these checks when it starts and every 5 minutes after that,
whether or not anyone has the page open. Opening or refreshing the page
runs them again, at most once every 30 seconds. Each row is a
measured value, never a verdict:

| Check | What is shown |
|-------|---------------|
| **Gateway address** | The router's IPv4 address, or the reason it could not be found. |
| **Gateway** | One ping; "answered in N ms" or "no answer within N ms". |
| **DNS** | One lookup of a fixed name; same timing format. |
| **Internet (Cloudflare)** | TCP connect to `1.1.1.1:443`; same format. |
| **Internet (Google)** | TCP connect to `8.8.8.8:443`; same format. |
| **Clock** | "synchronised" or "not synchronised". |
| **Cloud** | "no cloud service configured" (until that feature exists). |

---

## 4. Cameras

One row per configured camera:

| Field | What is shown |
|-------|---------------|
| **Camera** | The camera's name; its ID if no name is set. |
| **IP** | The configured host only — never a URL, username, or password. |
| **Answering** | "answered at HH:MM (N ms)", or once it starts missing, "no answer since HH:MM" with the consecutive‑miss count. Before its first check it reads "not checked yet". |
| **Recording** | Time of the last sealed recording segment, or "no sealed segment yet". |
| **Bitrate** | Median kbps, or "not measured". |
| **FPS** | Measured frames per second, or "not measured". |
| **MAC** | From the NVR's neighbour table, or "not in this NVR's neighbour table". |
| **Maker** | From the MAC's maker list, or "no maker list on this box". Never guessed. |
| **Model / Firmware / Serial** | From the latest matching discovery reply, or "not reported". |
| **MAC history** | "unchanged" or "first seen" normally. If the MAC on an IP changes, it instead reads "MAC for `<ip>` changed from `<old>` to `<new>` at `<time>`" — a measurement, not an accusation. |

The Answering field changes colour once a camera has missed three or more
checks in a row; one or two misses show only as text. Either way, the
words just state the measurement.

---

## 5. Other devices

One table, for devices the NVR has seen that are **not** configured cameras.
Columns: **IP, MAC, Maker, Interface, State, Model, Firmware**.

- A row learned from the NVR's neighbour table has an Interface and State,
  but reads "no discovery reply for this device" under Model/Firmware.
- A row learned instead from a discovery reply has Model/Firmware filled in,
  but reads "not in the neighbour table" under Interface/State.
- Incomplete neighbour entries (an all‑zero MAC, or marked FAILED/INCOMPLETE)
  are left out — they aren't devices.

If two discovery replies in one run answer on the same IP with different
MACs, both appear, in a separate box titled "Two devices answering on one
IP" — never averaged into one row.

---

## 6. "Look for cameras" button

- Runs a WS‑Discovery and SADP scan on the camera network only — nothing
  else is scanned.
- At most once every 60 seconds; the button greys out and shows when it's
  available again.
- Results are cached with the time they were found.

---

## 7. General notes

- The page never shows a credential — no password, no username, no
  `rtsp://` URL, anywhere.
- Anything that can't be measured says why, in place of a blank or a zero.
- This is phase 1 of a larger network/health/analytics/settings project,
  built on the NVR itself.

---

## 8. Not in this version

- **PoE port control** — needs a managed switch and its API.
- **Health history graphs** (coming later).
- **An active subnet sweep** — declined by the owner.
- **A speed test** — would spend the site's own bandwidth to run.
