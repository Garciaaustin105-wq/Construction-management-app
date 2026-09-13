# Review UI — spec (A3 slice 2: timeline with gaps + playback)

Written 2026-09-13 by Claude (orchestrator) after A3 slice 1 (`cfdbdea`, live
grid). Read against `agent/api-server.mjs` at that commit: `/timeline`,
`/playback` and `/segments/:id` already answer everything this page needs, so
this slice adds NO new API route, only a page, its pure module, and one leak fix.
Anything this file does not authorise, the code must not invent.

## Scope

A second plain page, `/review`: pick a camera and a day, see where there is
recording and where there is not (and why), click a moment, watch it.
NOT here: detections on the strip (nothing produces them yet — `/timeline`
returns coverage runs, no detection buckets), export (next slice). So the A3
exit test ("find a specific event from two days ago without being told how")
cannot pass at the end of this slice; it needs detections. Stated here, not
papered over.

## The feared failures

1. **A gap that renders as recording.** A 40 s outage in a 24 h strip is
   0.05 % of its width: drawn to scale it is invisible, and the strip then
   says "recorded" over a hole. Gaps are widened to a minimum visible width.
   Recorded runs never are (widening recording would hide a gap next to it).
2. **The future that renders as a gap.** Today's strip runs past now. The
   server clips the window (`effective`, `clippedToNow`); the part after now
   is neither recorded nor missing and gets its own kind, `future`.
3. **A URL built from unchecked response text.** The page puts `segmentId`
   into `/segments/<id>`. It is checked against the id grammar first.
4. **The storage path reaching the browser.** `resolvePlayback` returns `path`
   "for the server only", and `/playback` currently spreads the whole
   resolution into the response. Fixed in section 3.

## 1. `agent/ui/review-client.mjs` — pure, zero imports

Same rules as `live-client.mjs`: no `import`, no `node:`, no DOM, only
ECMAScript built-ins. The browser and the Node harness import the IDENTICAL
file. Refusals are VALUES (`{ error }`), never thrown. Times are compared as
milliseconds (`Date.parse` of the server's own ISO strings — these are
server output, not user input), never as strings.

### `layoutCoverage(body, minGapFraction = 0.004)`

`body` is the parsed JSON of a `/timeline` 200. Uses `body.requested`,
`body.effective` (each `{ startUtc, endUtc }`) and `body.runs`.

Returns `{ bars }` where each bar is, keys in this order:
`{ kind, startUtc, endUtc, left, width, widened, gapReason, gapSource }`.

- `left`, `width` are fractions of the REQUESTED range (0..1).
- One bar per run, in order; `kind` is the run's `"recorded"` or `"gap"`;
  `gapReason`/`gapSource` copied from the run (null for recorded).
- Then, only when `effective.endUtc` is before `requested.endUtc`, one final bar
  `kind: "future"` from `effective.endUtc` to `requested.endUtc`,
  `gapReason: null, gapSource: null`.
- A `gap` bar narrower than `minGapFraction` gets `width = minGapFraction` and
  `widened: true`; if that pushes `left + width` past 1, `left = 1 - width`.
  Every other bar: `widened: false`, true width.
- `startUtc`/`endUtc` are copied through as given (not re-formatted).

`{ error: string }` when: `body` is not an object; `requested`/`effective`
missing or a time does not parse; requested end <= requested start; effective
start is not requested start; effective end is after requested end or not after
effective start; `runs` is not a non-empty array; a run's `kind` is neither
`recorded` nor `gap`; the runs are not contiguous (first starts at effective
start, each starts where the previous ended, last ends at effective end);
`minGapFraction` is not a finite number in [0, 1).

### `fractionToInstant(fraction, startUtc, endUtc)`

Where a click at `fraction` of the strip lands. Clamps `fraction` to [0, 1];
`ms = start + Math.floor(fraction * (end - start))`; intervals are half-open,
so a result at or past `end` becomes `end - 1`. Returns
`{ utc: new Date(ms).toISOString() }`.
`{ error }` when `fraction` is not a finite number, a time does not parse, or
end <= start.

### `instantToFraction(utc, startUtc, endUtc)`

The playhead's position: `(t - start) / (end - start)`. Returns the number when
start <= t <= end; returns `null` when outside the range, when any time does
not parse, or when end <= start. (A null playhead is hidden, not pinned to an
edge.)

### `describeGap(reason, source)`

Plain words for a gap, ASCII only:

| reason | label |
|---|---|
| `camera_offline` | `Camera offline` |
| `appliance_offline` | `Recorder offline` |
| `disk_full` | `Not recorded: disk full` |
| `evicted_by_retention` | `Deleted by the retention policy` |
| `tampered` | `Tamper detected` |
| `unknown`, or any other value | `Not recorded: reason unknown` |

When `source === "inferred"`, append ` (nothing was logged for this hole)`.

### `planPlayback(body)`

`body` is the parsed JSON of any `/playback` response, success or refusal.
Returns one action, keys in this order:

- body not an object → `{ action: "error", code: "bad_response", message: "the recorder sent something unreadable" }`
- `body.ok === false` → `{ action: "error", code, message }` with `code`/`message`
  copied when they are strings, else `"bad_response"` / the unreadable message.
- `body.ok !== true` or `body.resolution` not an object → the `bad_response` error.
- `kind: "segment"` → `{ action: "play", src: "/segments/" + segmentId, offsetSeconds, segmentStartUtc, segmentEndUtc }`.
  `segmentId` must match `/^[A-Za-z0-9_-]{1,64}\.(0|[1-9][0-9]*)$/` and
  `offsetSeconds` must be a finite number >= 0, else the `bad_response` error.
  NEVER reads `resolution.path`.
- `kind: "gap"` → `{ action: "gap", label: describeGap(reason, source), nextRecordedUtc }`
  (`nextRecordedUtc` copied when a string, else null).
- `kind: "recording"` → `{ action: "live", segmentStartUtc }`.
- `kind: "future"` → `{ action: "future", nowUtc }`.
- any other kind → the `bad_response` error.

## 2. `agent/ui/review.html` — the page

Same look and plainness as `index.html` (dark, system font, no framework).
`<script type="module">` importing `/ui/review-client.js`.

- Header: `Live` link to `/`, title `Review`. (`index.html` gets a matching
  `Review` link to `/review`; one line, Claude-direct.)
- Controls: camera `<select>` from `fetch('/cameras')` (`name ?? cameraId`),
  `<input type="date">` defaulting to today (local), `Previous day` /
  `Next day` buttons.
- The day window is LOCAL midnight to the next local midnight:
  `new Date(y, m - 1, d)` and `new Date(y, m - 1, d + 1)`, sent as
  `.toISOString()`. (The Date constructor handles DST days of 23 and 25 hours;
  do not add 86 400 000.) Query strings built with `URLSearchParams`.
- `GET /timeline?camera&start&end&buckets=96`. On `ok: false` show `code` and
  `message` in the page's error line (a whole-future day is `window_in_future`).
- The strip: a full-width block, each bar an absolutely positioned child at
  `left*100%` / `width*100%`. Recorded: solid green. Gap: red, and a
  `title` tooltip of `describeGap` plus the local start–end times. Future:
  transparent with a dashed outline. Under it, local hour labels every 3 h.
  A legend names the three.
- Click the strip → `fractionToInstant(offsetX / strip width, requested)` →
  `GET /playback?camera&at` → `planPlayback`:
  - `play`: `video.src = src`; on `loadedmetadata` set
    `currentTime = offsetSeconds`, then `play()`. Status line shows the local
    time being played.
  - `gap`: stop the video; status shows the label; when `nextRecordedUtc` is
    non-null a `Jump to next recording` button plays from that instant.
  - `live`: status "This moment is still being recorded" + link to `/`.
  - `future`: status "That moment has not happened yet".
  - `error`: status shows `code: message`.
- Continuous play: on `ended`, request `/playback` at the finished segment's
  `segmentEndUtc` and follow the same plan (so play runs on across segments
  and stops, labelled, at a gap).
- Playhead: on `timeupdate`, instant = `segmentStartUtc` + `currentTime`;
  `instantToFraction` → position a 2 px marker; null → hide it.
- `video` `error` event → status "This browser cannot play this recording
  (H.265 needs hardware decoding)". Never a silent black box.

## 3. `agent/api-server.mjs` — Claude-direct

- Serve `GET /review` → `ui/review.html` and `GET /ui/review-client.js` →
  `ui/review-client.mjs`, same per-request read, `no-store`, content types and
  `ui_missing` 500 as slice 1 (fold into one path → file map).
- `/playback`: send the resolution WITHOUT `path` (copy the object, delete
  `path`). The contract says `path` is for the server only.

## 4. Harness — Claude-direct, written BEFORE dispatch

- `harness/reviewClient.harness.mjs` (new suite, added to `run-all.mjs`):
  every rule in section 1, including a 40 s gap in a 24 h window widened, a
  gap at the right edge shifted left, today's future tail, non-contiguous and
  overlapping runs refused, half-open click at fraction 1, a hostile
  `segmentId` refused, and `path` never appearing in a `play` action.
- `harness/apiServer.harness.mjs`: `/review` 200 text/html loading
  `/ui/review-client.js`; the module byte-equal to disk; `/playback` in a
  segment carries no `path` key; `layoutCoverage` accepts a real `/timeline`
  body from the running server.

Playback in a real `<video>` (seeking into a fragmented MP4, H.265 support)
needs a browser; that boundary is stated here, not faked.
