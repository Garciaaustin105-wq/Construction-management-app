# Camera AI plan

This replaces and widens "Phase D — detection" in BUILD-PLAN.md. Nothing here
is built. It waits until the Linux build (LINUX-BUILD-PLAN.md) passes stage 3,
because the NVR has to record reliably before anything watches the recordings.

## What Austin asked for (2026-09-16)

1. **After-hours person alerts** on chosen cameras.
2. **License plates at the gate:** read, search, optional known/unknown lists.
3. **Smart search in Review:** jump to every person or vehicle, no scrubbing.
4. **Ask in plain English:** "white truck at the gate yesterday afternoon".

All four run **on the NVR box**. Video never leaves the store, and it all keeps
working when the internet is down.

## Rules this plan keeps

- **The recorder never waits on the AI.** Detection is a separate service
  (`camplat-detect`). If it crashes, hangs or runs out of memory, recording is
  untouched. A harness proves this by killing it mid-run.
- **The AI reads the substream**, never the recording stream. On cameras with
  three streams it gets its own, so live view cannot starve it (AVYCON-MODELS.md).
- **Findings, not verdicts.** An event says "person, 0.82 confidence, camera 3,
  22:14:05" with the picture. It never says "intruder".
- **Nothing auto-acts.** Alerts notify. No doors, no sirens, no deletions.
- **No face recognition.** Not planned, not built.
- **Licenses:** no Ultralytics YOLO (AGPL), including YOLOv5/v8/v11 weights
  shipped in other model zoos. Every model's license is written beside it in
  `models/LICENSES.md` before it is used.
- **Plates are personal data.** Plate reads get their own retention setting,
  shorter than video by default, and every plate search is written to the audit
  log.
- **Plate reading has one on/off switch for the whole NVR** (installer only).
  Off stops new reads at once. Reads already stored follow their retention;
  turning it off is logged in the audit log with who did it.

## How it fits together

```
camera substream ──> camplat-detect ──> events table (SQLite, own file)
                      │  decode (QuickSync)       │
                      │  detector (Hailo-8)       ├─> Review: markers + search
                      │  plate reader             ├─> alert rules ─> phone
                      │  picture embedder         └─> plain-English search
                      └─ small crops on disk, own retention
```

- **Events** live in their own SQLite file, not the recording index, so a busy
  detector cannot lock the index (stage 2 already tests the index for SQLite
  busy errors).
- **Each event** holds: camera, time, kind (person / vehicle / plate), box,
  confidence, crop path, and for plain-English search an embedding.
- **New permissions:** `events.view` (store and installer), `alerts.manage`
  (installer), `plates.search` (installer by default; the installer can grant
  it to the store). A wall display gets none of them.

## Hardware

- **Sizing floor: 16 cameras per NVR** (Austin, 2026-09-16). At 5 frames a
  second that is about 80 detector frames a second, before plates and search.
- **Two models (decided 2026-09-16):** a Standard NVR (no chip) and an AI NVR
  (plus Hailo-8), both on the i3-N305 board since 2026-09-19 (Austin), so an
  upgrade is plugging the chip into the free NVMe slot, not a board swap. Same software; `camplat-detect` is installed
  and enabled only on the AI NVR, and every AI page and permission is hidden
  when it is absent. The Standard NVR never runs detection on its CPU.
- **Chip:** Hailo-8 M.2 2280 M-key (26 TOPS, about $199 standalone in
  September 2026). **Confirmed by Austin 2026-09-19** after weighing the
  Hailo-8L (13 TOPS, ~$70, in the first BOM), knowing the 8L would save ~$130
  a box but is likely short at 16 cameras. The 8L is no longer the fallback. Both vendors' model zoos ship detectors, a plate
  reader and CLIP pre-compiled. **To verify:** each model's license; measured
  frames a second on the N305 board's second NVMe slot (likely fewer PCIe lanes
  than the card can use); QuickSync decoding 16 substreams at once.
- **Slot:** the second M.2 must be PCIe NVMe. A SATA-only M.2 (common on mini
  PCs' second slot) will not take the card. The 6-bay N305 board in the BOM
  has two NVMe slots: one OS drive, one chip.
- **Decoding** the substreams uses the N305's QuickSync (chosen over the N150 for 16 substreams), not the Hailo chip. Every box has the N305.
- **Development** happens on the laptop NVR (G14) with the same models on
  ONNX Runtime, so D0–D2 do not wait for the Hailo chip.

## Stages

Each stage is contract, then harness, then code, then UI.

### D0. Contracts and a clip library (no hardware)
- `contracts/detection.ts`: event shape, confidence floors, dedupe (one event
  per person per camera per N seconds, not one per frame).
- `contracts/alertRules.ts`: cameras, schedule (business hours per weekday,
  holidays), zones, minimum confidence, cooldown.
- `contracts/uploadPolicy.ts`: which events become timeline markers.
- **Clip library:** recorded bench-camera clips (empty scene, one person,
  shadows and headlights, rain, a cat, a car at night) with hand-written
  expected events. Every later stage is scored against them.
- **Exit:** all contracts have FEARED checks (a headlight sweep is not a
  person; a schedule crossing midnight; a holiday).
- **Status (2026-09-16):** `detection.ts` and `alertRules.ts` done, with
  harnesses (two people at once stay apart; daylight saving in both
  directions; hours past midnight; holidays; cooldown; zones by the feet).
  `uploadPolicy.ts` now takes opening hours in the site's time zone (its old
  fixed UTC offset was an hour wrong all winter). `aiSettings.ts` holds the
  NVR-wide plate switch: off by default, no plate stored while off, an audit
  entry for every flip, and stored reads expire on schedule either way.
  The clip library's machinery landed on 2026-09-16 as well: `clipLibrary.ts`
  is the answer key and its scorer — `checkLibrary` refuses a key that could
  be wrong, `scoreLibrary` refuses to flatter a detector, and `exitGate`
  refuses a verdict on a sample too small to support one (20 expected people,
  an hour of empty scene). Review can save a range as a library entry
  (`agent/clip-library.mjs`), hard-linked into `.camplat-clips` so recorder
  eviction cannot delete the footage an answer key points at.
  Still to do: **the clips themselves** — real footage with hand-written
  expected events, which needs the bench camera. Until they exist the scorer
  has nothing to score, so D1 can be built but not passed.

### D1. The detector service (laptop, CPU/GPU)
- `camplat-detect` reads one substream, runs a permissive person/vehicle
  detector (YOLOX or a Hailo-zoo SSD), writes events.
- **Exit:** on the clip library, it finds at least 95% of the people and at
  most 1 false person per hour of empty-scene footage. Killing it with -9 for
  an hour leaves recording byte-for-byte unaffected.

### D2. Smart search in Review
- Markers on the Review timeline; filter by person or vehicle; "next event"
  and "previous event" buttons; a strip of crops to click through.
- **Exit:** finding a known person walk-by in 24 h of footage takes under
  30 seconds without scrubbing.

### D3. After-hours alerts
- Rules from D0, edited by the installer on a new page.
- **Delivery is a decision (below).** Every alert carries the crop and a link
  that opens Review at that moment.
- **Exit:** the BUILD-PLAN bar. False alerts are low enough that notifications
  stay on for a week at a real site.

### D4. License plates
- Plate detector plus reader on gate cameras only; results joined to vehicle
  events.
- Search by full or partial plate; optional known/unknown lists ("alert on an
  unknown plate after hours").
- **Exit:** measured read accuracy on the gate camera at day, night and rain,
  reported per condition. No single blended number (rule 17).

### D5. Plain-English search
- A picture embedder (CLIP family) stores an embedding for each event crop and
  for a keyframe per camera every few seconds. The query text is embedded on
  the CPU; Review shows the closest matches, newest first, with their scores.
- It **ranks**, it does not answer. "White truck" returns the most
  white-truck-like moments, and the person decides.
- **Exit:** on 20 written queries against the clip library, the right moment
  is in the top 10 for at least 15. Queries it fails are listed, not hidden.
- **Why last:** it needs D1's event crops, and it is the least predictable.

## Decisions for Austin

1. **Alert delivery:** a phone app push (waits for the mobile app), a text
   message (costs per message, needs a provider), or email first?
2. **Buy a Hailo-8 now**, or wait until D1 runs on the laptop CPU with the
   YOLOX test models (already downloaded to the bench PC)?
3. **Plate retention:** default days to keep plate reads (suggest 30), and
   whether store accounts can search plates.
4. **Which site first:** the car-wash gate camera is the obvious D4 test.
5. **Local laws on plate readers:** check the state before D4 ships to a
   customer.
