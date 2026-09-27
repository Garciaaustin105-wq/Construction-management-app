# Manager rules: areas, presence, rules, reports

The owner's decisions (2026-09-26; memory manager-ai-rules and
features-are-per-site-options, and bus notes camera-manager-rules and
camera-per-site-features):

- Regional and general managers build rules, from ready-made templates or
  their own.
- **"The manager left and came back"** without faces:
  - every customer has a camera pointed at the manager's desk, so desk
    presence is the main signal;
  - the car in the manager's parking spot backs it up;
  - doors catch anyone.

  Identity-free: a report never names a person. There is only ever one
  store manager, very rarely two. **No face recognition, ever.**
- A rule that fires gives a phone alert (build 2) plus a line in a daily
  report (this build).
- It is a per-site switch: some sites are storage facilities or homes.
- Customers' use of it is their business: no staff-notice features.
- Undecided, so do not build: whether a lapsed license stops alerts.

This is **build 1 of 3**: the engine and the pages. Build 2 is phone push
alerts. Build 3 is the manager's appearance of the day (clothing, no face).

## 1. Areas (the installer draws them)

- A named polygon on one camera, for example "Manager's desk", "Manager
  parking spot", "Back door", "Register 1". Up to 12 per camera.
- Stored in `<stateDir>/areas.json` as `{ id, cameraId, name, points }`,
  with points as 0..1 frame fractions, validated like zones.
- Installer only (`camera.manage`), audited, drawn with the existing
  zone-editor code from agent/ui/camera-ai-client.mjs.
- Managers see area names and a still with the area outlined, but never
  draw or edit areas.
- A rule may also use "whole camera" (no area).

## 2. Presence: occupancy from the raw frames

Occupancy comes from raw frames, never from events: a parked car becomes a
known object, and its EVENTS are hidden.

**Where.** In agent/detect-service.mjs's frame handler, right where `kept`
is formed (after the confidence floors, beside `advanceFold`), for each
area on that camera and each kind (person, vehicle).

**Inside means:**
- the detection's bottom-centre point is in the polygon; OR
- at least 40% of its box lies inside it, estimated on a 5x5 grid of
  points. This is needed for a person seated at a desk whose lower body the
  desk hides.

Use cameraAiSettings.ts `pointInZone` (edges count as inside). A detection
hidden by the camera's AI settings zones or kinds is NOT evidence: the same
"counts" decision the camera's settings make.

**Three states per (area, kind):** `present`, `absent`, `not_watching`.

- **Evidence**
  - A frame with a matching detection inside: presence evidence.
  - A frame with none inside: absence evidence.
  - No frame for that camera for longer than 120 s, the same threshold as
    the health "detecting" sample: `not_watching`.
  - The camera's AI schedule closed: `not_watching` straight away.
- **The motion gate:** it sends no frame line at all while a scene is
  still. A still scene therefore shows as not watching once 120 s pass
  without a frame. (A tracked still object is re-looked every ~3 s, and a
  keepalive of about 5 s keeps an empty scene reporting.) Never turn "no
  frame" into "absent".
- **Hysteresis**, fixed constants each with its reason in the code:
  - absent to present: needs presence evidence spanning >= 10 s
    (`MERGE_GAP_MS`), so someone walking past does not count;
  - present to absent: needs absence evidence spanning >= 30 s for a person
    and >= 60 s for a vehicle, so a missed frame or a lean does not count;
  - `not_watching` ends at the first frame, into whatever the evidence
    then says, after the same hysteresis.
- **Written as transitions only:** `occupancy.db` (node:sqlite, WAL) holds
  `(area_id, camera_id, kind, state, at_ms)`. detect-service is its only
  writer. Writes are small and synchronous, and a failure is logged, never
  thrown into the frame path.
- **Kept as long as the video:** transitions and rule firings older than
  the camera's oldest footage are deleted by the existing events-retention
  pass (EVENTS-RETENTION-SPEC.md), with the same horizon and margin.

## 3. Rules

**Rule model** (`contracts/managerRules.ts`; stored in
`<stateDir>/rules.json`):

```
{ id, name, enabled,
  template: "desk_unattended" | "away_and_back" | "after_hours_person" |
            "lingering" | "vehicle_arrives" | "vehicle_leaves" | "door_used" | "custom",
  cameraId, areaId | null (null = whole camera), kind: "person" | "vehicle",
  condition: { type: "enters" } | { type: "leaves" }
           | { type: "absent_longer_than", minutes }
           | { type: "present_longer_than", minutes }
           | { type: "away_and_back", minMinutes },
  when: "open_hours" | "closed_hours" | "always",
  notify: { alert: boolean, report: boolean, cooldownMinutes },
  createdBy, updatedUtc, updatedBy }
```

**Templates** (a template only pre-fills a rule; the manager can change
anything):

| Template | Kind | Condition | When | Alert | Report |
|---|---|---|---|---|---|
| Manager's desk unattended | person | absent_longer_than 20 | open_hours | on | on |
| Manager away and back (desk) | person | away_and_back 5 | open_hours | off | on |
| Manager's car away and back | vehicle | away_and_back 10 | open_hours | off | on |
| Person after hours | person, whole camera | enters | closed_hours | on | on |
| Lingering | person | present_longer_than 10 | always | on | on |
| Vehicle arrives | vehicle | enters | always | on | on |
| Vehicle leaves | vehicle | leaves | always | on | on |
| Door used | person | enters | always | off | on |

"Manager's desk unattended" is first in the list.

**Store open hours.** A new `openHours` field in site.json (an alertRules
`Schedule`, in the site time zone). It is edited in the Site section by the
installer or a manager. When `openHours` is null, a rule using open_hours or
closed_hours is refused with "set the store's open hours first". It never
guesses.

**Evaluation** runs in agent/api-server.mjs, reading occupancy.db every 5 s
plus a timer. It covers each condition over the (area, kind) transitions,
limited by `when` and by the rule's `cooldownMinutes`.

- **enters / leaves:** a transition into present, or into absent, from the
  other state. A transition from or into `not_watching` never counts as
  entering or leaving.
- **absent_longer_than / present_longer_than:** the state has lasted N
  minutes, with no `not_watching` inside that stretch. A not-watching gap
  restarts the clock.
- **away_and_back:** a completed absent stretch of at least minMinutes,
  bounded by present on both ends. It fires once, at the return, with the
  start, end and duration. A stretch that runs into `not_watching` is
  reported as "away from 2:10, then not watching from 2:40", never as a
  guessed return.

**Firings.** Each goes to `rules.db`: rule id, the snapshot of the rule's
name, camera, area, kind, what happened, start and end ms, duration, and
`alertWanted` (build 2 sends them). Wording is identity-free, for example
"Manager's desk unattended 2:10-2:55 (45 min)". Firings are never
re-derived when a rule is edited later: a firing keeps the name it had
(build rule 7).

## 4. Roles and switches

- **A new on-box role, `manager`.** It stands in on this box for the cloud
  plan's regional and general managers (CLOUD-B1-SPEC.md section 2).
  - Permissions: `rules.manage` (new), `events.view`, `live.view`,
    `playback.view`, `layout.edit`, and editing the site's open hours.
  - Not: camera, storage, system, account, network, or areas.
  - The installer creates manager accounts on the Accounts page, the same
    way store accounts are made.
- **The feature switch `managerRules`** in contracts/siteSettings.ts
  FEATURE_REGISTRY. Default off.
  - Presets: retail on, storage on, carwash on, home off, other off.
  - Off means the Rules and Reports nav links are hidden, their routes
    answer 404 `feature_off`, detect-service samples no occupancy, and the
    evaluator does not run.

## 5. Pages

- **Areas (installer, on the Cameras page):** draw, name, and delete
  areas, reusing the zone editor.
- **Rules (manager and installer):**
  - a template picker, "Manager's desk unattended" first;
  - a form with plain words: "When [a person] [is missing for more than]
    [20] minutes from [Manager's desk on Office camera] during [open
    hours], [alert me] and [add to the daily report]";
  - a list of rules with an on/off switch each;
  - the camera still with the chosen area outlined.
- **Reports (manager, installer, store):** the daily report per local day,
  newest first. Each firing is a line with its times and duration, grouped
  by rule. It links to Review at that camera and time
  (`/review?camera=&at=`). It shows "Reports go back to <date>, as far as
  this NVR keeps video."
- **All pages:**
  - phone width with a 16 px gutter;
  - dark;
  - untrusted names set as text;
  - every new client has its browser bootstrap AND the load check (bus
    note camera-page-bootstrap-lesson).

## Tests that matter

- **Occupancy**
  - A passer-by under 10 s never becomes present.
  - A 20 s dropout of a seated person never becomes absent.
  - A still scene with no frames for 120 s becomes not_watching, never
    absent.
  - The schedule closing becomes not_watching.
  - A car that is a known object still shows present in its spot.
  - A seated person with only the top 60% of the box inside counts as
    inside.
  - A settings-hidden detection is not evidence.
- **Rules**
  - A not_watching gap never produces enters, leaves or a completed away.
  - away_and_back gives the exact duration.
  - absent_longer_than fires once per stretch, respecting the cooldown.
  - closed_hours and open_hours follow openHours across a DST day.
  - A rule using hours when openHours is unset is refused.
- **Firings** keep their rule name after the rule is renamed.
- **Retention** deletes transitions and firings older than the footage,
  never newer.
- **Roles and switches**
  - Manager: 200 on rules and reports; 403 on areas, cameras and site
    settings except open hours.
  - A display: 403 on all of it.
  - managerRules off: 404 `feature_off`, no occupancy rows written, and
    the evaluator idle.
- **No names, credentials or URLs** in any file, JSON, audit or page.
