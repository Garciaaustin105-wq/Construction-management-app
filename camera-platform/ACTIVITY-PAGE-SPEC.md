# Activity page: sightings per camera by hour and day

Phase 3 of the network, health, analytics and settings work
(NETWORK-HEALTH-SETTINGS-RESEARCH.md). The owner approved it on 2026-09-25.

**Counts follow the video.** They are read from events.db, whose rows live
exactly as long as their footage (EVENTS-RETENTION-SPEC.md). There is no
long-term roll-up: that was the owner's decision.

## Who

The store role (managers) and the installer: permission `events.view`, which
both already hold. A display never sees it. Add a nav link on the pages the
store role uses.

## What a number means (say it on the page)

An event is ONE CONTINUOUS SIGHTING. Detections less than 10 s apart
(`MERGE_GAP_MS`) are one event. So:

- one person walking past is 1;
- the same person passing twice, 5 minutes apart, is 2;
- two people walking together may be 1.

The page calls them "**person sightings**" and "**vehicle sightings**", never
"people", "customers" or "visitors" (rule 11: report measurements). A single
line under the title explains this.

Other rules:

- **Hour of a sighting:** a sighting counts in the hour its `first_ms` falls
  in. It is never split across hours and never counted twice.
- **Known objects:** events hidden as known objects (`suppressed_by` set) are
  NOT counted. They are false detections of a parked car or a hanging object.
  Each bucket reports how many were hidden, and the page shows that as a
  small note, not as bars.
- **Plate reads** are not sightings and are left out.

## Watched, not watched

A zero means nobody was seen WHILE THE AI WAS WATCHING. A blank means it was
not watching. They must never look the same (rule 5).

Two measured bases per camera per hour, both in minutes:

- **`footageMin`:** minutes of the hour the camera has recorded video,
  from the index. This is the same coverage idea as contracts/timeline.ts.
- **`watchedMin`:** minutes the AI was watching.
  - **Source:** a new per-camera sample, `detecting` (0 or 1 per minute), in
    the health-history sampler. It is 1 when detect-health.json shows a frame
    or a gate window for that camera in the last 120 s.
  - **Before the sample existed** (the first install): `watchedMin` is
    `null` with the reason "watch time not measured before HH:MM". It is
    never assumed.

**A bucket shows:**

- the counts, plus "watched 42 of 60 min" when `watchedMin` < 60;
- "not watching" (a blank bar, hatched) when `watchedMin` = 0;
- "no video" when `footageMin` = 0.

The bucket colour never implies activity it did not measure.

## Time zone and days

- The API takes `tz`, an IANA name validated with Intl; the client sends
  its own `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Hours are local hours. A DST day has 23 or 25 of them, and that is correct.
- Days are local calendar days, built from local hours.
- There is no site time-zone setting yet (phase 4). When one exists, it
  replaces the browser's.

## API

**`GET /activity?range=24h|7d&tz=<IANA>[&camera=<id>]`** (`events.view`)

- **`range=24h`:** 24 local-hour buckets ending with the current hour.
- **`range=7d`:** 7 local-day buckets, each with its hour buckets.
- **Each bucket:** `{ startUtc, endUtc, person, vehicle, hidden, footageMin,
  watchedMin | null, watchedReason? }`.
- **Also returned:**
  - `countsFromUtc`: the oldest video this NVR still holds, which is how far
    back the counts reach. It is set per camera, from that camera's oldest
    segment, and never from the oldest sighting: keyed on the oldest
    sighting, a recorded, watched, quiet night would wrongly read "before
    the oldest video" (fixed 2026-09-26);
  - `watchMeasuredFromUtc`;
  - per-camera totals.
- Anything older than `countsFromUtc` is shown as "before this NVR's
  oldest video", never as 0.
- A bad `range`, `tz` or camera id is a 400. When there is no events.db,
  the answer is `available: false`, the same way `/events` says so.

## The page (`agent/ui/activity.html` and client)

- **Controls:** 24h / 7d and a camera filter (all cameras, or one), in one
  row above the charts.
- **Headline tiles** (measurements only):
  - total person sightings;
  - total vehicle sightings;
  - the busiest hour, as its time and count, with "of watched hours" noted.
- **Charts** (the dataviz skill's rules, as on the health charts):
  - **24h:** hourly bars. Person and vehicle are two separate charts on
    their own y-scales, never two scales on one chart. Up to 4 cameras are
    shown as a stacked-by-camera or grouped legend; past 4, small multiples.
  - **7d:** daily bars, the same way.
  - **Not-watching and no-video buckets:** drawn as the hatched texture
    with a label, never as an empty 0 bar.
  - Hover gives time, count, unit ("sightings"), watched minutes and hidden
    count.
  - Every chart has a table view.
- **Click-through:** clicking a bar opens Review at that camera and hour.
  Add URL parameters to Review (`/review?camera=<id>&at=<ISO>`), and make
  review-client read them. Test both the parameter parsing and the Review
  page's behaviour without them, which must be unchanged.
- **Explainer line:** "A sighting is one continuous stretch of someone (or a
  vehicle) in view. The same person passing twice counts twice."
- **Coverage line:** "Counts go back to <countsFromUtc> - as far as this NVR
  keeps video."
- **Layout:** phone width with a 16 px gutter, no sideways scroll, and dark
  mode. Reuse the health charts' validated palette and its SVG builder style
  (agent/ui/health-charts.mjs).

## Shape

1. **`contracts/activity.ts`** (pure): bucket sightings by local hour and day
   via Intl (DST-safe), merge `footageMin` and `watchedMin`, give each bucket
   its status, validate range, tz and camera, and pick the busiest hour among
   watched hours. It carries its own harness.
2. **I/O**
   - A new events-db method that reads the finished and unfinished events in
     a window for the cameras. It uses `idx_events_camera_first` and returns
     only kind, `first_ms`, camera and `suppressed_by`.
   - Footage minutes from the index.
   - `watchedMin` from the health-history store (the new `detecting`
     sample).
   - The route in api-server.
3. **UI:** activity.html, activity-client.mjs, the chart functions (pure SVG
   builders), the nav link, and the Review deep link.

## Tests that matter (rule 19)

- A DST spring-forward day has 23 hours; a fall-back day has 25.
- A sighting on an hour boundary lands in exactly one hour.
- Hidden (known-object) events are not in the counts, and ARE in `hidden`.
- A not-watching hour renders as the hatched "not watching", never as a 0
  bar.
- An hour before `watchMeasuredFromUtc` says "not measured", never 0.
- An hour before `countsFromUtc` says "before this NVR's oldest video".
- The words "people", "customers" and "visitors" never appear on the page as
  a count label.
- Store sees the page; a display gets 403.
- The Review deep link opens the right camera and time, and Review without
  parameters is unchanged.

## Not in this phase

- Unique-person counting, line crossing, occupancy and dwell. These need
  tracking across frames. OpenEye sells them as a separate licensed
  analytics tier.
- Any count kept longer than the video.
