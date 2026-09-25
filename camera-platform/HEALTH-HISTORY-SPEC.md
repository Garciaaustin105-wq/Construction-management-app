# Health history: graphs over time on the System page

Phase 2 of the network, health, analytics and settings work
(NETWORK-HEALTH-SETTINGS-RESEARCH.md). The owner approved it on 2026-09-24:
CPU, temperature, disk, and each camera's bitrate, over 24 hours and 7 days.
The System page today shows only "now". This adds "how it has been".

## Where the samples come from

**A sampler inside agent/api-server.mjs, every 60 s.** It follows the same
pattern as the network-facts sampler: unref()'d, with a close hook, and on
only in the real bootstrap (`healthHistoryEnabled`, default false; the
bootstrap passes true). Tests pass fakes and never read the real machine.

A separate systemd timer was rejected because upgrade.sh never creates units:
a new timer would need a re-install on every box. If the API service is down
there are no samples, and the graph shows that as a gap. That is true: the
NVR's own web service was down.

**Samples.** Every name carries its unit. A value that cannot be read writes
NO row, never a 0.

- **NVR**
  - `cpuPercent`: busy share from two `/proc/stat` readings 60 s apart. The
    first reading writes nothing. A counter that went backwards (reboot)
    writes nothing for that minute.
  - `load1`: from `/proc/loadavg`.
  - `memUsedMiB` and `memAvailableMiB`: from `/proc/meminfo`, where
    MemTotal minus MemAvailable is "used".
  - `tempC`: the CPU package temperature. Prefer the hwmon `coretemp`
    "Package id 0" input, then a thermal_zone of type `x86_pkg_temp`, then
    the hottest thermal_zone. Record which source was used, and show it under
    the chart.
- **Each recording drive** (store root, via statfs): `usedBytes` and
  `totalBytes`. The chart plots used %.
- **Each camera**
  - `recordedKbps`: bytes of segments sealed in the last 60 s, divided by
    their measured duration, from the index. A minute with no sealed segment
    writes nothing.
  - `recording`: 1 when a segment sealed in the last 120 s, else 0. This is
    a state, drawn as a strip, not a line.
- **Each network interface**: `rxMbps` and `txMbps`. Reuse the network-facts
  sampler's rates when it is running; otherwise compute them the same way
  (contracts/networkView.ts `counterRate`).
- **Recorder alive**: from health.json freshness (agent/healthfacts.mjs
  `recorderRunning`). Drawn as a strip.

**Store.** `<stateDir>/health-history.db`, using node:sqlite in WAL mode.
api-server is its only writer.

```sql
CREATE TABLE samples(
  at_ms INTEGER, metric TEXT, subject TEXT, value REAL,
  PRIMARY KEY(metric, subject, at_ms)
) WITHOUT ROWID;
```

`subject` is "nvr", a store root's label, a camera id or an interface name,
never a path with a user in it and never a URL. Rows older than 8 days are
deleted hourly in batches.

## Reading it

**`GET /health/history?range=24h|7d`**, with the same permission as
`/health`.

- **Bucketing:** 24h uses 5-minute buckets (288); 7d uses 1-hour buckets
  (168).
- **Buckets:** each series is `[{ startUtc, median, n }]`. The MEDIAN of the
  bucket's samples (build rule 14), with `n` the sample count. A bucket with
  `n = 0` is `median: null`, drawn as a break in the line.
- **States:** `recording` and recorder alive become run-length spans
  `[{ fromUtc, toUtc, state: "on"|"off"|"no samples" }]`.
- **Also returned:** `historyFromUtc` (the oldest sample kept), the
  temperature source, and each series' unit.
- Any other `range` value is a 400.

## The page (System page, a new "History" section)

- **Controls:** a 24h / 7d toggle in one row above the charts. A note says
  "history from HH:MM" when the store holds less than the range.
- **One y-axis per chart, always.** CPU % and temperature are separate
  charts, never one chart with two scales.
- **Charts**
  - CPU %, on a 0-100 axis.
  - Temperature in °C.
  - Memory used, in GiB.
  - Drives: used %, one line per drive.
  - Camera recorded bitrate in kbps. With up to 4 cameras, one chart with a
    legend and direct end labels. With more, small multiples: one small
    chart per camera on a shared y-scale.
  - Network: one chart per interface, rx and tx lines, with a legend.
  - A "Recording" strip per camera and a "Recorder running" strip: on / off /
    no samples.
- **Marks**
  - 2 px lines; the grid and axes recede; the y-axis label carries the unit;
    time labels are local.
  - Gaps are breaks, never interpolated across and never dropped to zero.
  - A crosshair and tooltip on hover show time, median, unit and the n
    behind it.
  - Every chart has a "table" view with the same numbers (accessibility).
- **Colour**
  - Categorical series take hues in a fixed order, never cycled. The palette
    is validated with the dataviz skill's `scripts/validate_palette.js` for
    light AND dark, against the System page's own surfaces.
  - Text uses text tokens, never the series colour.
  - Status colours are only for the on/off strips, and always carry a label.
- **Layout:** phone width with a 16 px gutter and no sideways scroll. Charts
  size to their container.
- **Code shape:** chart markup is built by a pure function (series in, SVG
  string out) so it can be tested in Node and saved as files to look at.

## Rules (each has a harness check)

- A blank is not a zero: no sample means no row and no point, and a gap
  shows as a break.
- Medians, never means.
- Units on every quantity: in the data, in the JSON, and on screen.
- Measurements, not verdicts: no "healthy" or "unhealthy" drawn on a graph.
  The existing System status chip is the only verdict, and it is unchanged.
- No credential, URL or rtsp:// in the store, the JSON or the page.
- Windows dev box: every Linux-only source answers "not available on this
  system" and writes no row. It never throws.

## Not in this phase

- Alert thresholds drawn on the graphs.
- History longer than 7 days.
- Activity counts, which are phase 3 and follow the video (owner's decision).
