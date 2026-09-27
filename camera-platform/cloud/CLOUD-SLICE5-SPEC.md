# Cloud slice 5: offering updates, and the access log (pure contracts)

This covers CLOUD-B1-SPEC.md section 6 (updates ride the outbound channel,
license-gated) and section 3 (a cloud-side "who viewed what" log). The
layout is the same as the earlier slices.

## contracts/updateOffer.ts

The box decides for itself whether to TRUST a release (the trust anchor,
agent/verify-release.mjs), and nothing here changes that. The cloud only
decides whether to OFFER one.

- **Types**
  - `Release`: `{ version: string (the git sha, 12 to 40 hex characters),
    channel: "stable" | "beta", publishedMs, minFromVersion: string | null,
    withdrawn: boolean }`.
  - `DeviceUpdateState`: `{ deviceId, currentVersion: string | null
    (unknown when null), channel: "stable" | "beta" }`.
- **`offerUpdate(device, releases, entitlement, nowMs)`** returns
  `{ offer: Release } | { offer: null, reason }`.
  - `entitlement` is slice 3's `entitled(..., "updates")` result. When it
    is not ok, return `offer: null` with the SAME reason. A lapsed license
    means no updates (the owner's rule).
  - Candidates: releases on the device's channel, not withdrawn, with
    `publishedMs <= nowMs`. A beta device also gets stable releases.
  - Pick the newest by `publishedMs`. On a tie, the lexically greatest
    version wins, so the choice is deterministic.
  - Already on it gives `offer: null` with `"up_to_date"`.
  - `minFromVersion` set but not equal to `currentVersion` (including an
    unknown current) gives `offer: null` with `"needs_intermediate"`.
    Never offer a jump the release says it can't take.
  - No candidates gives `"no_release"`.
  - A malformed version gives `"bad_version"`.

## contracts/accessLog.ts

- **Types**
  - `AccessEntry`: `{ atMs, userId, role, action: "live_view" |
    "playback" | "export" | "snapshot" | "settings_change" | "claim" |
    "login", siteId, cameraId: string | null, transport: "local" |
    "direct" | "relay" | null, ok: boolean, reason: string | null }`.
- **`checkAccessEntry(raw)`** lists every problem.
  - Reasons: `"bad_time"`, `"bad_user"`, `"bad_action"`, `"bad_site"`,
    `"bad_transport"` (a video action with a null transport, or a
    non-video action WITH a transport) and `"secret_like"`.
  - `"secret_like"` means some string field contains "rtsp://", "@" in a
    URL-like string, "password=", or a 40+ character base64-ish run. This
    is defence in depth: an entry must never carry a credential.
- **`redactForInstaller(entry, privacyBlocked: boolean)`:** when the
  client blocked the installer (slice 2), the cameraId of video actions
  is replaced by null. The installer still sees THAT access happened, not
  which camera. Otherwise the entry is unchanged. It returns a new object.
- **`summarize(entries, fromMs, toMs)`** returns `{ total, byAction:
  Record<action, number>, byTransport: {local, direct, relay, none},
  relayShare: number | null }`.
  - It uses a half-open window.
  - `relayShare` is relay / (local + direct + relay), null when there are
    no video actions.

## Tests that matter

- **updateOffer:**
  - a lapsed license never offers, whatever releases exist;
  - withdrawn and future releases are skipped;
  - a beta device sees stable and beta, a stable device only stable;
  - needs_intermediate, including an unknown current version;
  - the tie-break is deterministic;
  - up_to_date.
- **accessLog:**
  - each reason;
  - an rtsp URL or password in any string field gives secret_like;
  - redaction only when blocked, and only video cameraIds;
  - summarize's window edges;
  - relayShare null with no video.
