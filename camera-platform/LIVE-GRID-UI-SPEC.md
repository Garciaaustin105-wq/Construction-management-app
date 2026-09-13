# Live grid UI — spec (A3 slice 1)

Written 2026-09-13 by Claude (orchestrator) after the live edge landed on the
api server (`3580bd6`: `ws://host:port/live/<cameraId>` answers on the appliance
port). This file is the contract for the UI slice; anything it does not
authorise, the code must not invent.

## Scope of this slice

The live grid ONLY: the appliance serves one plain page that shows every
configured camera live. NOT here: timeline with gaps, playback, export (next
A3 slices). Deliberately plain — no framework, no build step, no npm: the
appliance is a box in a closet, and the page is two files.

## Why MSE and what is hard about it

ffmpeg emits fragmented MP4 (`-movflags frag_keyframe+empty_moov`, `-c copy`)
on stdout; `agent/live.mjs` relays each stdout chunk as one WS binary frame.
A browser plays this through Media Source Extensions — but WS chunks do not
align to MP4 box boundaries, and `SourceBuffer.appendBuffer` needs whole
media segments. So the client must re-assemble box boundaries itself. That
re-assembly is the feared part of this slice, and it is PURE — which is why
it lives in its own module the harness can import directly.

Cameras are H.265 (FIELD-NOTES assumption 1b) — the codec string must be
built from the `hvcC` record, and the browser may still refuse (HEVC needs
hardware decode). The page must say so out loud in the tile, never silently
black-frame.

## 1. `agent/ui/live-client.mjs` — pure, zero imports

No `import`, no `node:` builtins, no DOM: the browser `<script type="module">`
and the Node harness import the IDENTICAL file. Refusals are VALUES
(`{ error }`), never thrown.

### `createBoxAccumulator()`

Returns `{ push(chunk) -> Uint8Array[], flush() -> Uint8Array[] }`. Chunks are
`Uint8Array` of arbitrary size; box boundaries may fall inside a chunk.
Top-level box parsing: 4-byte big-endian size + 4CC type; `size === 1` → the
next 8 bytes are the 64-bit largesize; `size === 0` → the box extends to end
of stream (emit only on flush). Emissions, in order:

1. **init** — once: every byte from stream start through the END of the first
   top-level `moov` (normally `ftyp`+`moov`), as ONE buffer.
2. **media segments** — each top-level `moof` immediately followed by its
   `mdat`, emitted as ONE contiguous buffer (moof+mdat together = one
   appendable media segment).
3. any other complete top-level box (`free`, `sidx`, …) emitted individually.
4. `flush()` emits a trailing incomplete remainder as-is (a broken append is
   better than silently dropped bytes) plus any `size === 0` box.

### `extractMimeCodec(initSegment)`

Walks the init segment (`ftyp` then `moov` → `trak` → `mdia` → `minf` →
`stbl` → `stsd`, first sample entry per trak) and returns
`{ mime }` or `{ error }`:

- video `avc1` → child `avcC` → `avc1.` + avcC bytes 1,2,3 as six lowercase
  hex chars (profile, compat, level).
- video `hvc1`/`hev1` → child `hvcC` (ISO 14496-15; verified against the
  WebCodecs HEVC registration and Chromium's parser):
  prefix is the entry type itself; then `general_profile_space` (byte 1 top
  2 bits; 0 omitted, else letter A/B/C) + `general_profile_idc` (bottom 5
  bits, decimal); then `general_profile_compatibility_flags` (bytes 2–5,
  BIT-REVERSED, hex, leading zeros omitted); then tier letter (`L`/`H` from
  bit 5 of byte 1) + `general_level_idc` (byte 12, decimal); then the six
  constraint bytes 6–11 as dot-separated hex, trailing zero bytes omitted.
  Main@L3.1 → `hvc1.1.6.L93.B0`.
- audio `mp4a` → child `esds` → AudioSpecificConfig's 5-bit
  audioObjectType (escape value 31 reads 6 more bits) → `mp4a.40.<aot>`.
- `mime` = `video/mp4; codecs="<video>[, <audio>]"` — audio term present only
  when an mp4a track exists.
- `{ error }` when: no `moov`, no video track, an unrecognised video entry
  fourcc, or a video entry whose `avcC`/`hvcC` is missing or shorter than its
  declared layout.

## 2. `agent/ui/index.html` — the page

Inline CSS/JS plus `<script type="module" src="/ui/live-client.js">`. No
framework. Dark, responsive (`repeat(auto-fill, minmax(320px, 1fr))`).

- `fetch('/cameras')` → one tile per camera (`cameraId`, `name ?? cameraId`).
- Each tile opens `ws(s)://location.host/live/<cameraId>?quality=substream`,
  `binaryType = "arraybuffer"`.
- First binary message → `extractMimeCodec` → if `{ mime }` and
  `MediaSource.isTypeSupported(mime)`: attach, `SourceBuffer` with
  `mode = "sequence"`, appendBuffer(init), then append each emission chained
  on `updateend` (never queue a second append while one is pending). When
  buffered length exceeds ~20 s, remove from the start.
  `isTypeSupported` false or `{ error }` → tile says the browser cannot play
  this camera's codec (HEVC needs hardware decode) and closes the socket.
- Text message → JSON envelope. `substream_unavailable` → retry mainstream
  once (automatic by default); any other refusal → show `code` in the tile.
- `live_ended` / `live_stalled` / `live_source_failed` → show code + message
  with a Reconnect button. No auto-reconnect loop (v1 never hammers a camera).
- Tap a tile → that tile enlarges and switches to `mainstream`; tap again →
  back to substream. One WS per camera at a time — close before reopening.
- The browser answers the server's WS pings itself; the page contains NO
  frame-handling code for control frames.

## 3. `agent/api-server.mjs` — serving (Claude-direct, small)

Two routes before the no-route fallback: `GET /` → `join(import.meta.dirname,
'ui', 'index.html')`, `GET /ui/live-client.js` → `join(import.meta.dirname,
'ui', 'live-client.mjs')`; both `no-store`, correct `Content-Type` (`text/html;
charset=utf-8` / `text/javascript`), read per request so edits land without a
restart; a failed read → 500 `{ ok: false, code: "ui_missing", … }`.

## 4. Harness (Claude-direct — verification never delegates)

Append to `harness/apiServer.harness.mjs`; import `live-client.mjs` directly.

- accumulator: feed a fixture split at EVERY byte offset boundary class
  (1-, 3-, 7-byte chunks) → exactly one init emission + one moof+mdat
  emission, concatenation byte-equal to the fixture; a 64-bit largesize box
  arrives whole; a `size === 0` box emits only on flush; a trailing partial
  emits only on flush.
- `extractMimeCodec`: synthetic init segments BUILT IN-HARNESS — avc1+mp4a →
  exact `avc1.640028, mp4a.40.2` string; hvcC Main@L3.1 → exact
  `hvc1.1.6.L93.B0`; unknown fourcc → `{ error }`; no moov → `{ error }`.
- HTTP: `/` → 200 text/html containing `/ui/live-client.js` and `/live/`;
  `/ui/live-client.js` → 200 text/javascript byte-equal to the on-disk file;
  `/ui/nope` → 404 `no_such_route`.

MSE playback itself needs a browser — that boundary is stated here and not
papered over with a fake.