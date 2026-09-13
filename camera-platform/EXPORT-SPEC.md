# Export — spec (A3 slice 3)

Written 2026-09-13 by Claude (orchestrator) after A3 slice 2 (`3b3b326`, review
UI). Read against `agent/api-server.mjs`, `agent/segindex.mjs` and
`contracts/indexCoverage.ts` at that commit. Anything this file does not
authorise, the code must not invent.

## Scope

"Export" = a person picks a camera and a time range on the review page and
downloads the footage as ONE file they can hand to someone else.

The file is a **store-only ZIP** holding:

- the **whole recorded segments** that intersect the range, one `.mp4` per
  segment, named `<cameraId>/<segment start, ':' replaced by '-'>.mp4`;
- `manifest.json`, written last, listing every file with its SHA-256 and byte
  count, every gap inside the range with its reason, and the requested and
  delivered ranges.

Two phases, dispatched separately:

- **Part 1 (this dispatch):** two pure contracts, `contracts/zipStore.ts` and
  `contracts/exportPlan.ts`, each with its harness.
- **Part 2 (next, not yet authorised):** the `/export` route, the manifest
  builder, and the export control on the review page.

## The feared failures

1. **An export that stitches across a gap.** One continuous clip built from
   14:09–14:10 and 14:12–14:13 plays as two unbroken minutes. A viewer, or a
   court, is then told nothing happened during an outage. So segments are
   **never joined**: each is its own file, its start time is in its name, and
   every gap in the range is listed in the manifest with its reason.
2. **An export that silently delivers less than it says.** A segment could be
   evicted or truncated between planning and streaming. Part 2 checks every
   file's streamed byte count against the plan. On a mismatch it destroys the
   connection, so the download fails visibly rather than completing as a
   short, valid-looking ZIP.
3. **A range that reaches the segment still being written.** Its size and end
   are not known, and a copy of it is not a fixed piece of evidence. Refused,
   with the instant to end before.
4. **An archive past ZIP32's limits.** A ZIP32 over 4 GiB, or over 65 535
   entries, wraps its offsets and opens as corrupt, or worse, opens as a
   different set of files. Refused in the plan, before any byte is sent.
5. **The storage path reaching the browser.** `path` exists in the plan for the
   server. Neither the manifest nor any response carries it.
6. **A blank taken as zero.** A sealed segment with `bytes` null cannot be
   sized. Refused rather than counted as 0 (build rule 5).

Not trimming to the exact range is deliberate. A cut inside a segment needs a
keyframe-aligned remux (ffmpeg) or a re-encode, and a re-encode is no longer
the recorded bytes. The manifest states `requested` and `delivered` separately.

## 1. `contracts/zipStore.ts` — pure byte builders

No imports. No TextEncoder (not in the contracts' lib), so entry names are
restricted to ASCII and written one byte per character. Little-endian
throughout. Every entry is **stored** (method 0) with general-purpose flag
bit 3: CRC and sizes are unknown when the local header goes out, so they
follow the data in a data descriptor. Hence the archive streams with no temp
file and no second read of a multi-GB segment. The ZIP layout, per entry:

```
local file header | file bytes | data descriptor
... then every central directory header, then the end-of-central-directory record
```

The doc comments in the file are the byte-level spec. The harness pins exact
bytes for each builder, and it round-trips a built archive through an
independent reader in the harness that checks CRCs against `node:zlib`'s
`crc32`.

## 2. `contracts/exportPlan.ts` — which files, which gaps, or a refusal

`planExport(cameraId, segments, gaps, range, nowUtc)`:

- `segments`, `gaps`: every row for the camera (`forCamera`, `gapsFor`).
- `range`: already clipped by `parseWindow` (its `effective`), so it ends at
  or before now.
- Coverage comes from `coverageFromIndex`, and its throws propagate. The gaps
  a manifest lists are therefore the same gaps the review strip draws.
- Selection is half-open, on the index's own start/end: a segment is in when
  `start < range.end` and `end > range.start`. An open segment counts as
  ending at now.
- Refusals are values: `{ ok: false, status: 422, code, message }`, checked in
  this order:
  `export_reaches_recording`, `export_nothing_recorded`,
  `export_size_unknown`, `export_too_large`.

## 3. Part 2 — the route, the stream, the manifest

Decided 2026-09-13 after part 1 landed and after reading `api-server.mjs`,
`segindex.mjs` and `evict.mjs`.

- `GET /export?camera=&start=&end=`: `isCameraId`, then `parseWindow`, then
  `index.inRange(camera, effective.start, effective.end)` and
  `index.gapsFor(camera)`, exactly as `/timeline` reads them, then
  `planExport`. `IndexCoverageError` becomes 500 `index_state_invalid`, as it
  does on `/timeline`. A refusal goes out through `sendError` with its own
  status and code.
- `Content-Type: application/zip`,
  `Content-Disposition: attachment; filename="<cameraId>_<start>_<end>.zip"`
  (the `:` in the times replaced by `-`), and no Content-Length: sizes are
  known, but a mid-stream abort must not look like a complete body.
- `agent/exportStream.mjs`, `streamExport(out, plan, { resolvePath,
  generatedAtUtc })`. Per file: local header (DOS time from the file's
  `startUtc`), then the file's bytes through CRC-32 and SHA-256, honouring
  backpressure, then the data descriptor. If a file is missing, or its byte
  count differs from the plan in either direction, the promise rejects before
  anything further is written. The route then calls `res.destroy()`, so no end
  of central directory ever goes out and the download fails visibly.
- `manifest.json` is the last entry. It comes from a pure
  `exportManifest(plan, sent, generatedAtUtc)` in `contracts/exportPlan.ts`,
  built from what was **sent** (the SHA-256 and byte count measured while
  streaming), not from the index. No `path` in it. ASCII JSON.
- **`hold` is not set by export.** The API process would have to write to the
  index and clear the flag afterwards. A crash between the two leaves a
  segment held forever, which retention then silently cannot evict. What
  protects the export instead: on Linux an open read stream survives an unlink,
  and a file that is already gone, or shorter than planned, destroys the
  response (feared failure 2). A download that fails visibly can be retried. A
  hold that sticks fills the disk.
- Then an export control on the review page, carrying the selected range.
