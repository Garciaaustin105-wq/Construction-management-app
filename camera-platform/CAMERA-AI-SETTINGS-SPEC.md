# Per-camera AI settings: zones, schedule, sensitivity, kinds

Phase 4, round 1 of the network, health, analytics and settings work. The
owner approved it on 2026-09-26. Round 2 is site settings and layouts.

Per camera, an installer can set:

1. **Zones:** where on the picture to watch, and where to ignore.
2. **Schedule:** when the AI watches this camera.
3. **Sensitivity:** this camera's minimum confidence.
4. **Kinds:** which detections count here (person, vehicle).

## Rules that shape it

- **Nothing is deleted by a setting.**
  - A detection outside the zones, or of a kind switched off, is still
    stored as an event but HIDDEN: `suppressed_by = "settings:zone"` or
    `"settings:kind"`. It is flagged, the same way known objects hide
    things, so Review's "show hidden" can still find it, and the Activity
    page counts it under "hidden".
  - A detection below the camera's minimum confidence is not an event at
    all. That is the same meaning the site-wide storing floor
    (detect.json `minConfidence`) already has.
- **Settings apply from the moment they are saved.** Earlier events are
  not re-judged. The form says so.
- **Settings-hidden beats known objects.**
  - Known-objects learning ignores events hidden by settings.
  - `setSuppressed` never overwrites a `settings:` value with an object id.
  - A known object's reset (`clearSuppressed`) never clears a `settings:`
    value.
  - Test all three.
- **Outside the schedule the AI is NOT WATCHING, and says so.**
  - Frames for that camera are ignored: not folded, not stored.
  - detect-health.json shows the camera as not watching
    (`aiSchedule: { open: false, sinceUtc }`), and the health-history
    `detecting` sample writes 0. The Activity page therefore shows "not
    watching", never "0 sightings".
  - Round 1 does not stop the worker, so CPU use is unchanged; the form
    says so. Stopping workers is a later step.
- **Minimum confidence** can only be set at or above the site storing
  floor (detect.json `minConfidence`). It is 0.30 to 0.90 in steps of
  0.05, or "site default" (inherit). It is never below the floor, because
  the worker does not keep what the floor drops.
- **A blank is not a zero.**
  - No zones means the whole frame is watched.
  - No schedule means always.
  - Missing kinds means both on.
  - The file stores exactly what was chosen; absent fields mean the
    defaults above and are never written as zeros.

## Data

`<stateDir>/camera-ai.json`, written tmp then rename:

```json
{ "version": 1,
  "cameras": {
    "<cameraId>": {
      "zones": [ { "id": "z1", "mode": "watch"|"ignore", "points": [[x,y], ...] } ],
      "schedule": null | <alertRules Schedule>,
      "minConfidence": null | number,
      "kinds": { "person": true, "vehicle": true },
      "updatedUtc": "...", "updatedBy": "<account name>"
    } } }
```

- **Points** are fractions of the frame (0..1, rounded to 4 places), the
  same `Zone` shape as contracts/alertRules.ts. A zone has 3 to 32 points;
  there are at most 8 zones per camera.
- **Schedule** reuses contracts/alertRules.ts `Schedule` and its DST-safe
  `isOpen`.
  - Its `timeZone` is the NVR's own zone
    (`Intl.DateTimeFormat().resolvedOptions().timeZone` on the box) until
    the site time-zone setting exists (round 2). The form shows which zone
    the times are in.
- **Every save is audited** through the existing auth audit: who, which
  camera, and which fields changed. Never a URL, never a credential.

## The zone test

- **Which point:** a detection's position is the bottom-centre of its best
  box (where a person or vehicle meets the ground), as a fraction of the
  frame. Find the units of `bestBox` / `best_x..best_h` and the frame size
  where the worker reports them; do not guess.
- **The judgement:**
  1. It is inside an **ignore** zone: hidden (`settings:zone`).
  2. Otherwise, if any **watch** zone exists and it is inside none of them:
     hidden (`settings:zone`).
  3. Otherwise it counts.
- **Geometry:** point-in-polygon with even-odd, and concave polygons
  allowed. A point exactly on an edge counts as inside.

## Where it runs

- **agent/detect-service.mjs**
  - It re-reads camera-ai.json every 30 s. A bad file is logged and the
    previous good settings are kept; if there never was a good file, the
    defaults apply. Nothing crashes.
  - It applies, in this order, before the known-objects check in the event
    store step: the per-camera minimum confidence, the kinds, the zones.
  - Schedule: every tick it asks `isOpen`; while closed it ignores that
    camera's frames and reports it closed in detect-health.
- **agent/health-history.mjs:** the `detecting` sample is 1 only when the
  camera's schedule is open AND a frame or gate window is fresh.
- **API**
  - `GET /camera-ai-settings` returns every camera's settings plus the
    storing floor and the NVR's time zone. Permission `camera.manage`.
  - `POST /camera-ai-settings/<cameraId>` saves one camera. Permission
    `camera.manage`. It validates with the contract and answers 400 with
    every problem listed.
  - Store and display users are refused.
- **UI (the Cameras page):** an "AI settings" panel per camera.
  - **Zone editor** over a current still (`/still`, `playback.view`, which
    the installer has):
    - tap to add points and close the shape;
    - choose Watch or Ignore;
    - delete a zone;
    - works with mouse and touch;
    - zones drawn with a legend (Watch / Ignore), never colour alone.
  - **Schedule:** "Always", or per weekday on/off plus from/to times.
  - **Sensitivity:** "site default (0.50)" or a value.
  - **Kinds:** person and vehicle checkboxes.
  - **Save button**, with its errors shown.
  - **Notes:** "applies to new detections from now on" and "outside the
    schedule the AI is not watching; CPU use is unchanged for now".
  - **Layout:** phone width with a 16 px gutter and no sideways scroll.
  - **The client MUST have its browser bootstrap**, with a check that loads
    it the way a browser does (bus note camera-page-bootstrap-lesson;
    harness/activityPage.harness.mjs has the pattern).

## Tests that matter (rule 19)

- **Zone test:**
  - a point on an ignore zone inside a watch zone is hidden;
  - no watch zones means the whole frame counts;
  - concave polygons;
  - the edge case;
  - the box-to-point units.
- **Stored events:**
  - an out-of-zone event is stored hidden (`settings:zone`), not dropped;
  - a kind switched off is stored hidden (`settings:kind`);
  - below the camera threshold, nothing is stored;
  - a minimum confidence below the storing floor is refused by the
    validator.
- **Known objects:** they never overwrite, clear or learn from `settings:`
  events.
- **Schedule:**
  - outside it, frames are ignored, detect-health says closed, and the
    `detecting` sample writes 0;
  - a DST day uses the right hours.
- **Bad or missing file:** the last good settings are kept and nothing
  crashes.
- **API:**
  - store gets 403 and a display 403;
  - an invalid body gets 400 listing every problem;
  - each save writes an audit entry;
  - no credential appears anywhere.
- **Page:** the bootstrap check, the form round-trip, and the zone editor
  producing fractions.

## Not in this round

- Stopping workers outside the schedule (CPU saving).
- Motion-gate sensitivity per camera.
- Plate reading per camera: aiSettings.ts's switch stays NVR-wide.
- Line crossing and loitering.
