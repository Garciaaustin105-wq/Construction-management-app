# Live stream negotiation + WS live endpoint — spec

The A2 spec deferred two things to "the next slice": the `liveNegotiation`
contract and the WS endpoints. This is that slice. It is what A3's live grid
stands on; playback and timeline already work over plain HTTP.

Nothing here re-encodes. `-c copy` only: the appliance's CPU is not a transcode
farm, and 16 mainstreams plus recording must coexist. A camera that cannot be
copied is refused, not transcoded.

The standing rule from BUILD-PLAN applies: **automatic by default, manual
always available.** A camera whose substream cannot be derived still works if
its config carries a manual `substreamUrl` (level-3 input, used verbatim).

---

## 1. `contracts/liveNegotiation.ts` (pure, no I/O)

Style: identical to the other contracts — TypeScript, discriminated unions with
`kind`, refusals are VALUES (never classes, never thrown), doc comments carry
the why. Read `contracts/cameraView.ts` and `contracts/httpRange.ts` first.

### Types

```ts
export type LiveQuality = "mainstream" | "substream";

export type LiveRefusalReason =
  | "unknown_camera"        // cameraId not in config
  | "unresolved_camera"     // resolveCameraUrl returned {kind:"unresolved"}
  | "substream_unavailable" // no manual substreamUrl, and the vendor has no derivation
  | "camera_busy"           // per-camera concurrent-live cap already held
  | "stream_limit";         // appliance-wide concurrent-live cap held

export type LiveNegotiation =
  | { kind: "ok"; cameraId: string; quality: LiveQuality;
      mode: "ws-fmp4"; streamId: string }
  | { kind: "refused"; reason: LiveRefusalReason; detail: string };
```

### Functions

```ts
export function negotiateLive(input: {
  cameraId: string;              // the id the CALLER resolved; echoed verbatim on ok
  cameraExists: boolean;         // the CALLER does the config lookup; this contract never searches
  quality: LiveQuality;          // the CALLER validates the query string; this contract
                                 // assumes a valid quality and never parses one
  resolution: CameraResolution;  // from resolveCameraUrl — unresolved -> refused
  substreamUrl: string | null;   // manual override from config, verbatim when present
  vendorDerivesSubstream: boolean; // true only for vendors with a known substream path rule
  activeForCamera: number;       // live streams already running for this camera
  activeTotal: number;           // live streams already running appliance-wide
  maxPerCamera: number;          // default 2
  maxTotal: number;              // default 16
  streamId: string;              // caller-generated (crypto.randomUUID), echoed when ok
}): LiveNegotiation
```

Decision order is load-bearing — a camera that is unknown must never be told
"busy" (that leaks that the camera exists and is watched). Evaluate in exactly
this sequence and return on the first hit:

1. `!cameraExists` → `unknown_camera`
2. `resolution.kind === "unresolved"` → `unresolved_camera`
3. `quality === "substream"` && `substreamUrl` null && !`vendorDerivesSubstream` → `substream_unavailable`
4. `activeForCamera >= maxPerCamera` → `camera_busy`
5. `activeTotal >= maxTotal` → `stream_limit`
6. else `{ kind: "ok", cameraId, quality, mode: "ws-fmp4", streamId }`

The caller resolves the camera BEFORE calling; `cameraId` reaches this function
already validated, and the ok result echoes it verbatim.

`detail` is a short human sentence for each refusal (e.g. `unknown_camera` →
`"no camera with that id in this site's config"`). Details NEVER contain a
stream URL or credentials — same scrub discipline as `cameraView.ts`; if a
reason ever echoes config text, replace url/password with `***` first.

```ts
export function liveFfmpegArgs(url: string): string[]
```

The live muxing command, `-c copy` only. Returns the ARGV AFTER the url:
`["-rtsp_transport","tcp","-i",<url>,"-c","copy","-f","mp4","-movflags",
"frag_keyframe+empty_moov","-fflags","+nobuffer","-flags","low_delay","pipe:1"]`
— caller prepends `"ffmpeg"`. Pure so it is checkable without spawning.

---

## 2. `agent/live.mjs` — the WS endpoint (Node built-ins only)

ESM, same style as `agent/api-server.mjs` and `agent/recorder-service.mjs`.
Hand-rolled WebSocket (the repo has zero dependencies by rule): HTTP upgrade on
the SAME server api-server already runs — `server.on("upgrade")`, pathname
`/live/<cameraId>`, query `?quality=mainstream|substream`.

### Handshake

- Only GET upgrades with `Sec-WebSocket-Key` present. Otherwise `socket.destroy()`.
- Accept = base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")) — `node:crypto`.
- Refusal path: complete the upgrade, send ONE text frame carrying the JSON
  error envelope (`{ok:false, code, message}`), then a close frame, then destroy.
  The client sees why it was refused — a bare socket close is how bugs hide.

### Framing (server side needs only these)

- Outgoing binary: opcode 2, payload = one ffmpeg stdout chunk. Chunks may
  exceed 65535 bytes → use 16-bit length for ≤65535, 64-bit length above (mask
  bit 0; server frames are never masked).
- Outgoing text: opcode 1, same envelope shape as HTTP errors.
- Ping (opcode 9) every 20s of silence; a missed pong (no opcode 10 within
  30s) = dead client → tear down.
- Incoming: the client sends nothing but pongs and close (opcode 8). On close:
  echo close, kill ffmpeg, free the slot. Masked client frames MUST be
  unmasked (bit 4 of byte 1) — a masked frame handled unmasked corrupts silently.

### Lifecycle

- On upgrade: resolve camera (`cameraExists` from config, `resolution` from
  `resolveCameraUrl`), read `activeForCamera`/`activeTotal` from the live
  module's own registry, call `negotiateLive`. Refused → refusal frame.
- `spawnFn` injectable (recorder's pattern — the whole loop is exercisable
  against a fake producer with no ffmpeg and no camera). Spawn
  `ffmpeg <liveFfmpegArgs(resolution.url)>` with stdio
  `["ignore","pipe","pipe"]`. stdout → WS binary frames as chunks arrive.
  stderr → keep the LAST 10 lines in memory for the failure message.
- On ffmpeg exit: if any bytes were sent → send text `{ok:false,
  code:"live_ended", message:<last stderr line or "source closed">}`, then
  close. If NO bytes were sent → code `live_source_failed` with the stderr
  tail. Never include the URL in either — scrub like cameraView.
- Stall watchdog: no stdout bytes for 15s → kill child, `live_stalled`.
- Registry: module-level Map<streamId, entry> with `{cameraId, child,
  startedAt}`; caps enforced through `negotiateLive` with the registry's own
  counts. `closeAll()` exported so server shutdown and the harness can clean up.

---

## 3. Harness checks (Claude-direct — never delegated)

The postmortem's rule: verification is the orchestrator's lane. Minimum set:

Contract: unknown camera refused first even when everything else is saturated;
unresolved refused before substream/busy; substream_unavailable only when no
manual URL and vendor cannot derive; manual substreamUrl used verbatim wins
over vendor derivation; camera_busy at the cap with the OTHER cap far from
held; stream_limit at the appliance cap; ok carries mode ws-fmp4 and echoes
streamId; liveFfmpegArgs is -c copy only (no `-vf`, no `-c:v`).

WS integration (fake spawnFn writing deterministic pseudo-random bytes — the
zero-filled lesson from the postmortem): upgrade on unknown camera gets the
JSON refusal then close; happy path delivers binary frames and the streamId
was negotiated first; client close kills the fake child (assert killed) and
frees the slot (next negotiation ok); ffmpeg exit with no bytes →
live_source_failed carrying stderr tail but NOT the credential-bearing URL;
stall watchdog fires at 15s with fake time; masked client close frame is
handled (unmasking path) without corrupting state.

---

## Sequencing

Dispatch 1 (this slice's only delegation): implement section 1,
`contracts/liveNegotiation.ts`, exactly, no other files. Claude verifies
against this spec, then Dispatch 2 (agent/live.mjs) gets its own brief, then
the harness. One file per dispatch — the postmortem's first lesson.