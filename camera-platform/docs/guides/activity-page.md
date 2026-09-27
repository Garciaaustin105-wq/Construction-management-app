# Activity Page – Quick Reference for Store & Regional Managers

## 1. What the page shows
The Activity page shows how many person sightings and vehicle sightings each camera recorded, by hour (last 24 hours) or by day (last 7 days).
- Counts are read from the recorder's event database and only last as long as the video that recorded them — there is no separate long-term summary.

## 2. Who can see it
- Store-role users (managers) and the installer role already have access. It's linked from the main navigation on the pages store-role users use.
- Displays never see this page — they get a 403 (access denied).

## 3. Page controls
| Control | What it does | Label |
|---|---|---|
| Range toggle | Switches between hourly and daily views | "24h" and "7d" buttons |
| Camera filter | Choose one camera or all of them | "Camera" dropdown; default option "All cameras" |

## 4. Headline tiles
- "person sightings" – total person sightings in the selected range.
- "vehicle sightings" – total vehicle sightings in the selected range.
- "busiest hour (of watched hours)" – the hour with the highest count, shown as its time range and count. Only hours the AI actually watched are considered.
- If no hour has been watched yet, this tile shows the value "not yet measured" with the label "busiest hour" beneath it.

## 5. Charts
On the page these are grouped under "Person sightings" and "Vehicle sightings".
- 24h view: a bar per hour. 7d view: a bar per day. Same rules for both.
- Person and vehicle sightings are always two separate charts with their own y‑scales — never combined on one scale.
- Up to 4 cameras appear together in one chart; more than 4 cameras each get their own small chart.
- Hovering (or keyboard-focusing) a bar shows: the camera and time, the count (e.g. "N person sightings"), watched minutes when the AI watched less than the whole bar (an hour on the 24h chart, a day on the 7d chart), and hidden count when any were hidden.
- Every chart also has a "Table view" you can expand — the same time, sightings, hidden and coverage numbers as rows and columns, for exact figures.

## 6. Interpreting the numbers

### 6.1 What is a "sighting"?
The page says: "A sighting is one continuous stretch of someone (or a vehicle) in view. The same person passing twice counts twice."
- The same person passing again 5 minutes later is a second sighting.
- Two people walking together may count as only one sighting.

### 6.2 Hour assignment
A sighting is counted in the hour its first detected moment falls in — never split across hours, never counted twice.

### 6.3 Hidden (known-object) events
Events suppressed because they match a known object (e.g., a parked car) are not counted as sightings. Each bucket's "hidden" column and tooltip show how many were hidden that hour.

### 6.4 What the bars mean
| Bar | Meaning |
|---|---|
| Ordinary bar, any height (including a flat 0) | A real measurement — the AI was watching, and that many sightings were counted. |
| Hatched bar labeled "not watching" | Video exists, but the AI was not watching that hour. |
| Hatched bar labeled "no video" | The camera had no recorded footage for that hour. |
| Hatched bar labeled "before this NVR's oldest video" | Too old — before the oldest video this NVR still keeps. |
| Hatched bar labeled "watch time not measured" (sometimes "...before HH:MM") | Watching wasn't being tracked yet at that time. |

Every hatched bar is drawn full-height — never as an empty space and never as a plain 0 bar, so a gap in data is never mistaken for a quiet hour. Its label is written on the bar when the bar is wide enough; on narrow bars (several cameras in one chart) the label is in the tooltip and the table view instead.
- When the AI watched only part of a bar's time, a "watched N of M min" note shows next to the count. M is the bar's own length: 60 for an hour, about 1,440 for a day on the 7d chart.

## 7. Clicking a bar – Review page
- Clicking any bar — including a hatched one — opens the Review page for that camera at the bar's own start time.
- URL pattern: `/review?camera=<id>&at=<ISO>`.

## 8. Additional notes
- **Time zone:** the page does not use your browser's own time zone. It shows times using the site's configured time zone (SITE-SETTINGS-SPEC.md) when the installer has set one, otherwise the recorder's own system time zone.
- **DST:** a local day can have 23 or 25 hours; the page handles this correctly.
- **Coverage:** "Counts go back to <date/time> — as far as this NVR keeps video" tells you how far back the counts reach. Anything older shows as "before this NVR's oldest video," never as 0.
- Watch time is only measured from a certain point on; anything earlier shows "watch time not measured," never 0.

## 9. Quick FAQ
| Question | Answer |
|---|---|
| Do I see "people" or "customers" on the page? | No — always "person sightings" and "vehicle sightings." |
| What if I want data older than the NVR's oldest video? | It shows as "before this NVR's oldest video," not 0. |
| Will the page change if I switch time zones? | No — it follows the site's configured zone or the recorder's own system zone, not your browser's. |

---
*This summarizes only what ACTIVITY-PAGE-SPEC.md, SITE-SETTINGS-SPEC.md (site time zone setting) and the Activity page's own code currently provide.*
