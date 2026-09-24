# Network page: the site's local network, seen from the NVR

Phase 1 of the network / health / analytics / settings work (research:
NETWORK-HEALTH-SETTINGS-RESEARCH.md). Owner's decisions, 2026-09-23:
- show cameras in full, plus a PASSIVE list of other devices;
- no subnet sweep;
- build this first, on the NVR itself.

The competitor splits this across a recorder screen, a cloud inventory
report and a desktop overlay. This is one screen, with live numbers they do
not have.

## Who

Installer only. Add a new permission `network.view`, granted to the installer
role and to nothing else (not store, not display). Add routeAccess entries
for `GET /network` (api) and `GET /network-page` (page). Default deny stays
tested.

## What the page shows

1. **Interfaces.** For each network card:
   - name, IPv4/CIDR, MAC;
   - link up or down (carrier);
   - negotiated speed (Mb/s) and duplex;
   - receive and transmit rates in Mb/s: now, and a 60-minute strip from
     1-minute samples;
   - error and drop counts since the page's sampling began.

   Mark which card the cameras are on (camera IPs inside its subnet).

2. **Connection checks.** Run on page request (at most once per 30 s) and
   every 5 minutes. Each is a measured value and a time, never a verdict
   beyond "answered in N ms" or "no answer within N ms".
   - **Gateway:** one ICMP echo via the `ping` binary (`execFile`, no shell).
   - **DNS:** `dns.promises.lookup` of one fixed name.
   - **Internet:** TCP connect to 1.1.1.1:443 and 8.8.8.8:443.
   - **Clock synchronised:** `timedatectl show -p NTPSynchronized --value`.
   - **Cloud:** "no cloud service configured" until CLOUD-B1 exists.

3. **Cameras.** Every configured camera:
   - **Id and name.**
   - **IP.** The host from config: never the URL, never a user name or
     password.
   - **Answering.** A TCP connect to the camera's RTSP port every 60 s, 2 s
     timeout. Show the last-answered time, round-trip ms, and "no answer
     since" with the count of consecutive misses.
   - **Recording.** Last sealed segment time, from the index.
   - **Measured bitrate.** Median kbps, as agent/healthfacts.mjs already
     gives it.
   - **Frames per second.** Only if it is already measured somewhere
     reusable; otherwise "not measured".
   - **MAC.** From the NVR's neighbour table for that IP; otherwise "not in
     this NVR's neighbour table".
   - **Maker.** From the MAC's OUI, using the box's own list if present
     (`/usr/share/ieee-data/oui.txt`, `/usr/share/misc/oui.txt`); otherwise
     "no maker list on this box". Never guessed.
   - **Model, firmware, serial.** From the latest discovery reply that
     matches the IP or MAC; otherwise "not reported".
   - **MAC history.** When the MAC seen for a camera's IP differs from the
     last one recorded, show "MAC for <ip> changed from A to B at T" (a
     swapped camera, or two devices sharing one address). A measurement, not
     a verdict. Keep it in `<stateDir>/network-macs.json` (ip, mac,
     firstSeenUtc, lastSeenUtc), written tmp then rename.

4. **Other devices this NVR has seen without scanning.**
   - Neighbour-table entries that are not configured cameras: IP, MAC, maker,
     interface, state.
   - Discovery responders that are not configured cameras: model, firmware.
   - Incomplete neighbour entries (all-zero MAC, FAILED or INCOMPLETE) are
     not devices, so they are left out.

5. **"Look for cameras" button.** Runs the existing WS-Discovery
   (agent/wsdiscovery.mjs) and SADP (agent/sadp.mjs) on the camera card,
   exactly as `camctl discover` does. At most once per 60 s. Results are
   cached with their time.
   - **Two devices on one IP:** if two replies in one run give the same IP
     with different MACs, show both. That is measured, not inferred.

## Rules (each one has a harness check)

- **Never a credential.**
  - `/network` JSON, the page and every log line never contain `rtsp://`, a
    configured camera user name or password, or the camera.secret contents.
  - The harness configures a camera whose URL carries user:pass and asserts
    none of it appears anywhere.
- **No scanning.** The only packets this feature causes:
  - TCP connects to configured cameras' RTSP ports;
  - one ICMP echo to the default gateway;
  - one DNS lookup;
  - two TCP connects for the internet check;
  - the discovery multicasts when the button is pressed.

  The I/O is injected, and the harness records every destination, asserting
  nothing else was contacted.
- **A blank is not a zero.** Every field that could not be measured says
  why. Linux-only sources (`/proc`, `/sys`, `ip`, `ping`, `timedatectl`)
  answer "not available on this system" on a Windows dev box, never a throw.
  The harness runs on Windows.
- **Measurements, not verdicts.** Times, counts and ms. The page may colour a
  camera that has missed three or more connects in a row; the words still
  state the measurement.
- **Samplers.** api-server starts them, unref()'d, with a close hook, the same
  pattern as the events-retention timer. The page says "measured since
  HH:MM" because the in-memory history starts at service start.

## Shape (build rules 1 and 2)

1. **`contracts/networkView.ts`.** Pure. It parses `ip -j neigh` /
   `/proc/net/arp` and `/sys/class/net` counters, then merges the sources
   into rows:
   - configured cameras;
   - neighbour entries;
   - discovery replies;
   - OUI lookup;
   - probe results;
   - recording facts;
   - MAC history.

   It also turns counter samples into rates (handling counter reset and
   wrap), and detects MAC changes and same-IP-different-MAC replies. It
   carries its own harness.
2. **`agent/network-facts.mjs`.** I/O only, every source injectable.
3. **`agent/api-server.mjs`.** `GET /network` (JSON), `POST /network/discover`
   (the button; `network.view` plus the rate limit), and `GET /network-page`.
4. **`agent/ui/network.html` and `agent/ui/network-client.mjs`.**
   - Phone width: 16 px gutter, no sideways scroll; tables collapse to cards.
   - Add a nav link where the installer's other pages link to System.

## Not in phase 1

- PoE port control (needs a managed switch and its API).
- Health history graphs (phase 2).
- An active subnet sweep: declined by the owner.
- A speed test: it would spend the site's bandwidth, and the competitor does
  not have one either.
