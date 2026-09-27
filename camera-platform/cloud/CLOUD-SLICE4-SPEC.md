# Cloud slice 4: choosing the video path, local HTTPS names (pure contracts)

The owner's rule (2026-09-27; memory local-first-video, bus note
camera-local-first): "always try to connect customer to nvr first", and
"use the cloud directly for video for last resort". The cloud does the
introduction; the video goes local, then direct peer-to-peer, and through
the cloud relay only as the last resort. Always show which path a session
got. The layout is the same as the earlier slices.

## contracts/transport.ts

- **Types**
  - `PathKind`: `"local" | "direct" | "relay"`.
  - `Attempt`: `{ kind: PathKind, startedMs, endedMs, outcome: "connected"
    | "failed" | "timeout" | "not_tried", reason: string | null }`.
- **`TRANSPORT_ORDER = ["local", "direct", "relay"]`**, fixed and never
  reordered.
- **`TRY_BUDGET_MS = { local: 1500, direct: 6000, relay: 8000 }`:** how long
  each attempt may take before it counts as a timeout.
- **`nextPath(attempts: Attempt[], opts: { relayAllowed: boolean, lanHint:
  "same_lan" | "different_lan" | "unknown" })`** returns
  `{ try: PathKind } | { give_up: true, reason }`.
  - It always goes in TRANSPORT_ORDER, skipping a path only when it was
    already attempted in this session.
  - `lanHint "different_lan"` skips local. `"unknown"` or `"same_lan"`
    tries local first.
  - Relay is tried only if relayAllowed. Otherwise, after direct fails, it
    returns `give_up` with `"relay_not_allowed"`. relayAllowed is false
    when the license check says no (slice 3), when a site policy forbids
    it, and so on; the caller decides.
  - Everything tried and nothing connected gives `give_up`
    `"all_paths_failed"`.
  - An attempt with outcome "connected" means `nextPath` returns
    `give_up` `"already_connected"`, a caller bug made harmless.
- **`sessionSummary(attempts)`** returns `{ connectedVia: PathKind | null,
  triedInOrder: PathKind[], msToConnect: number | null, relayUsed:
  boolean }`. This is what the app shows ("Connected: direct") and what
  the cost report counts. `msToConnect` runs from the first attempt's
  start to the connected attempt's end.
- **`relayShare(summaries)`** returns `{ sessions, relay, share: number |
  null }`. `share` is null when there are no sessions, never 0.

## contracts/localName.ts

This gives each NVR its own HTTPS name that points at its LAN address, so
the cloud-served website and app can reach it on the local network (the
Plex `*.plex.direct` pattern). Browsers block a cloud HTTPS page from
calling plain http on the LAN.

- **`localHostname(deviceId, lanIp, zone)`**
  - `lanIp` is a private IPv4 (10/8, 172.16/12 or 192.168/16).
  - The result is `"<ip with dashes>.<deviceId lowercased>.<zone>"`, for
    example `"192-168-1-50.abcd1234.nvr.example.com"`.
  - It returns `{ ok: true, hostname } | { ok: false, reason }`, with
    reasons `"not_private_ip"`, `"bad_ip"`, `"bad_device_id"` (anything but
    base32 [a-z2-7], 16 to 32 characters, after lowercasing) and
    `"bad_zone"`.
  - Each label must be at most 63 characters and the hostname at most 253,
    otherwise `"too_long"`.
- **`parseLocalHostname(hostname, zone)`** is the inverse. It returns
  `{ ok: true, lanIp, deviceId } | { ok: false, reason }` and never
  throws.
- **`certRenewalDue(notAfterMs, nowMs)`** is true at or within 30 days of
  expiry. A non-finite input gives true (renew rather than trust garbage).

## Tests that matter

- **transport:**
  - the order is always local, then direct, then relay;
  - different_lan skips local;
  - relay is refused when not allowed;
  - already_connected;
  - all_paths_failed;
  - relayShare is null with no sessions;
  - summary timing.
- **localName:**
  - a public IP is refused, including 8.8.8.8, 172.32.0.1 and 192.169.0.1;
  - the 172.16/12 edges: 172.16.0.0 is ok and 172.31.255.255 is ok;
  - the round trip;
  - uppercase deviceIds are lowercased;
  - the label length limits;
  - a zone mismatch in parse;
  - renewal exactly at 30 days is due.
