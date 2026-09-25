/** Health history (HEALTH-HISTORY-SPEC.md): the CPU/mem/temp/bitrate
 *  arithmetic and the bucketing/spans that turn stored samples into what
 *  GET /health/history returns. The failures feared are the ones the spec
 *  and AGENTS.md name outright: a reset counter read as negative, an empty
 *  bucket rendered as a zero instead of a break, a mean standing in for a
 *  median, and a boundary sample landing in two buckets (or none). */
import {
  parseProcStat,
  cpuPercent,
  parseProcLoadavg,
  parseProcMeminfo,
  chooseTempSource,
  recordedKbps,
  recordingStateSample,
  bucketSamples,
  buildStateSpans,
  validateHistoryRange,
} from "../dist/healthHistory.js";
import { check, same, close, report } from "./_assert.mjs";

console.log("healthHistory");

// ---------------------------------------------------------------------------
// /proc/stat and cpuPercent
// ---------------------------------------------------------------------------

const PROC_STAT_TEXT = (user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0) =>
  [
    `cpu  ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 0 0`,
    `cpu0 ${user} ${nice} ${system} ${idle} ${iowait} ${irq} ${softirq} ${steal} 0 0`,
  ].join("\n");

check("parseProcStat: reads the aggregate 'cpu ' line, not a per-core line", () => {
  const sample = parseProcStat(PROC_STAT_TEXT(100, 0, 50, 800, 10, 0, 0, 0));
  same(sample, { user: 100, nice: 0, system: 50, idle: 800, iowait: 10, irq: 0, softirq: 0, steal: 0 }, "parsed fields");
});

check("parseProcStat: missing fields beyond idle default to 0, not unmeasured", () => {
  const sample = parseProcStat("cpu  100 0 50 800\n");
  same(sample, { user: 100, nice: 0, system: 50, idle: 800, iowait: 0, irq: 0, softirq: 0, steal: 0 }, "old-kernel shape");
});

check("parseProcStat: no 'cpu ' line, or too few fields, is null -- never thrown", () => {
  same(parseProcStat("cpu0 1 2 3 4\n"), null, "only per-core lines present");
  same(parseProcStat("cpu  1 2 3\n"), null, "fewer than 4 fields");
  same(parseProcStat(""), null, "empty file");
});

check("REQUIRED: cpuPercent with no previous reading is 'no_previous', not a number", () => {
  const next = parseProcStat(PROC_STAT_TEXT(100, 0, 50, 800));
  const result = cpuPercent(null, next);
  same(result.kind, "no_previous", "kind");
  same(typeof result.percent, "undefined", "no numeric percent field on a first reading");
});

check("cpuPercent: two ordinary readings a tick apart give a busy percentage", () => {
  // idle grows by 900 of 1000 total jiffies elapsed -> 10% busy.
  const prev = parseProcStat(PROC_STAT_TEXT(1000, 0, 1000, 8000));
  const next = parseProcStat(PROC_STAT_TEXT(1050, 0, 1050, 8900));
  const result = cpuPercent(prev, next);
  same(result.kind, "ok", "kind");
  close(result.percent, 10, 0.01, "busy percent");
});

check("REQUIRED, THE FEARED ONE: a backwards CPU counter (reboot) is 'counter_reset', never negative or 0", () => {
  const prev = parseProcStat(PROC_STAT_TEXT(50_000, 0, 50_000, 900_000));
  const next = parseProcStat(PROC_STAT_TEXT(100, 0, 50, 800)); // small numbers: the box rebooted
  const result = cpuPercent(prev, next);
  same(result.kind, "counter_reset", "kind, not ok");
  same(typeof result.percent, "undefined", "no numeric percent field at all on a reset");
});

check("cpuPercent: idle time itself moving backwards while total still grows is also a reset", () => {
  const prev = parseProcStat(PROC_STAT_TEXT(1000, 0, 1000, 9000));
  const next = parseProcStat(PROC_STAT_TEXT(3000, 0, 3000, 8000)); // idle shrank even though total rose
  same(cpuPercent(prev, next).kind, "counter_reset", "idle went backwards");
});

check("cpuPercent: an idle box stays within [0, 100] even at the edges", () => {
  const prev = parseProcStat(PROC_STAT_TEXT(0, 0, 0, 8000));
  const next = parseProcStat(PROC_STAT_TEXT(0, 0, 0, 8100)); // all idle, all the delta
  const result = cpuPercent(prev, next);
  same(result.kind, "ok", "kind");
  close(result.percent, 0, 0.01, "fully idle");
});

// ---------------------------------------------------------------------------
// /proc/loadavg and /proc/meminfo
// ---------------------------------------------------------------------------

check("parseProcLoadavg: reads load1, the first field only", () => {
  same(parseProcLoadavg("0.52 0.58 0.59 2/389 12345\n"), 0.52, "load1");
});

check("parseProcLoadavg: empty or garbage text is null, never 0", () => {
  same(parseProcLoadavg(""), null, "empty");
  same(parseProcLoadavg("not a number here\n"), null, "garbage");
});

const MEMINFO_TEXT = [
  "MemTotal:       16384000 kB",
  "MemFree:          200000 kB",
  "MemAvailable:    8000000 kB",
  "Buffers:          100000 kB",
].join("\n");

check("parseProcMeminfo: MemTotal minus MemAvailable is 'used', converted to MiB", () => {
  const result = parseProcMeminfo(MEMINFO_TEXT);
  close(result.memAvailableMiB, 8000000 / 1024, 0.01, "available MiB");
  close(result.memUsedMiB, (16384000 - 8000000) / 1024, 0.01, "used MiB (NOT MemTotal - MemFree)");
});

check("parseProcMeminfo: missing MemAvailable (an old kernel) is null, not computed from MemFree", () => {
  const text = ["MemTotal:       16384000 kB", "MemFree:          200000 kB"].join("\n");
  same(parseProcMeminfo(text), null, "no MemAvailable field");
});

check("parseProcMeminfo: on Windows there is no such file at all -- empty text is null, never thrown", () => {
  same(parseProcMeminfo(""), null, "not available on this system");
});

// ---------------------------------------------------------------------------
// Temperature source
// ---------------------------------------------------------------------------

check("chooseTempSource: prefers hwmon coretemp 'Package id 0' over everything else", () => {
  const hwmon = [
    { chip: "coretemp", label: "Core 0", tempC: 40 },
    { chip: "coretemp", label: "Package id 0", tempC: 55 },
  ];
  const zones = [{ zone: "thermal_zone0", type: "x86_pkg_temp", tempC: 90 }];
  const result = chooseTempSource(hwmon, zones);
  same(result, { kind: "measured", tempC: 55, source: "hwmon coretemp Package id 0" }, "hwmon wins over a hotter zone");
});

check("chooseTempSource: falls back to a thermal_zone typed x86_pkg_temp when hwmon has no package sensor", () => {
  const zones = [
    { zone: "thermal_zone0", type: "acpitz", tempC: 30 },
    { zone: "thermal_zone1", type: "x86_pkg_temp", tempC: 60 },
  ];
  const result = chooseTempSource([], zones);
  same(result, { kind: "measured", tempC: 60, source: "thermal_zone x86_pkg_temp" }, "the named zone, not the cooler one");
});

check("chooseTempSource: falls back to the hottest thermal_zone of any type", () => {
  const zones = [
    { zone: "thermal_zone0", type: "acpitz", tempC: 45 },
    { zone: "thermal_zone1", type: "iwlwifi_1", tempC: 62 },
  ];
  const result = chooseTempSource([], zones);
  same(result, { kind: "measured", tempC: 62, source: "hottest thermal_zone (iwlwifi_1)" }, "the hottest one, named");
});

check("REQUIRED, THE FEARED ONE: no hwmon and no thermal_zone at all is unmeasured, never a fabricated 0C", () => {
  const result = chooseTempSource([], []);
  same(result.kind, "unmeasured", "kind");
  same(typeof result.tempC, "undefined", "no numeric field at all");
});

// ---------------------------------------------------------------------------
// Per-camera recorded bitrate
// ---------------------------------------------------------------------------

check("recordedKbps: bytes over measured duration across sealed segments in the window", () => {
  const segments = [
    { bytes: 1_000_000, startUtc: "2026-09-24T00:00:00.000Z", endUtc: "2026-09-24T00:00:30.000Z" }, // 30s
    { bytes: 1_000_000, startUtc: "2026-09-24T00:00:30.000Z", endUtc: "2026-09-24T00:01:00.000Z" }, // 30s
  ];
  const result = recordedKbps(segments);
  same(result.kind, "measured", "kind");
  // 2,000,000 bytes * 8 / 60s / 1000 = 266.67 kbps
  close(result.kbps, (2_000_000 * 8) / 60 / 1000, 0.01, "kbps");
});

check("REQUIRED: a minute with no sealed segment is unmeasured, never 0 kbps", () => {
  const result = recordedKbps([]);
  same(result.kind, "unmeasured", "kind");
  same(typeof result.kbps, "undefined", "no numeric field at all");
});

check("recordedKbps: zero-duration segments (a malformed index entry) is unmeasured, not Infinity", () => {
  const segments = [{ bytes: 1000, startUtc: "2026-09-24T00:00:00.000Z", endUtc: "2026-09-24T00:00:00.000Z" }];
  same(recordedKbps(segments).kind, "unmeasured", "no measurable duration");
});

// ---------------------------------------------------------------------------
// Recording state sample (0/1, from the last seal)
// ---------------------------------------------------------------------------

check("recordingStateSample: 1 when sealed within the last 120s, else 0", () => {
  same(recordingStateSample("2026-09-24T00:00:00.000Z", "2026-09-24T00:01:00.000Z"), 1, "60s ago");
  same(recordingStateSample("2026-09-24T00:00:00.000Z", "2026-09-24T00:03:00.000Z"), 0, "180s ago");
});

check("recordingStateSample: never sealed is 0, not unmeasured -- this is always answerable", () => {
  same(recordingStateSample(null, "2026-09-24T00:00:00.000Z"), 0, "no lastSealedUtc at all");
});

// ---------------------------------------------------------------------------
// Bucketing: medians, n, and boundary placement
// ---------------------------------------------------------------------------

const RANGE_START = "2026-09-24T00:00:00.000Z";

check("REQUIRED: an even-count bucket is the mean of its two middle values, a MEDIAN not a mean of the whole set", () => {
  const samples = [
    { atUtc: "2026-09-24T00:00:10.000Z", value: 1 },
    { atUtc: "2026-09-24T00:00:20.000Z", value: 2 },
    { atUtc: "2026-09-24T00:00:30.000Z", value: 3 },
    { atUtc: "2026-09-24T00:00:40.000Z", value: 100 }, // an outlier a mean would be dragged by
  ];
  const buckets = bucketSamples(samples, RANGE_START, "24h");
  same(buckets[0].n, 4, "n");
  // sorted: 1,2,3,100 -> median (2+3)/2 = 2.5, NOT the mean 26.5.
  close(buckets[0].median, 2.5, 0.0001, "median of an even count");
});

check("REQUIRED: an empty bucket has n=0 and median=null, never median=0", () => {
  const buckets = bucketSamples([], RANGE_START, "24h");
  same(buckets.length, 288, "288 five-minute buckets over 24h");
  same(buckets[0], { startUtc: RANGE_START, median: null, n: 0 }, "no samples at all -> null, not 0");
});

check("REQUIRED, THE FEARED ONE: a sample exactly on a bucket boundary lands in exactly one bucket", () => {
  // 5 minutes after the range start is the START of bucket index 1, not the
  // end of bucket 0 -- each bucket is a half-open [start, start+5min).
  const boundaryUtc = "2026-09-24T00:05:00.000Z";
  const samples = [{ atUtc: boundaryUtc, value: 42 }];
  const buckets = bucketSamples(samples, RANGE_START, "24h");
  same(buckets[0], { startUtc: RANGE_START, median: null, n: 0 }, "bucket 0 does NOT get it");
  same(buckets[1].n, 1, "bucket 1 gets it, exactly once");
  same(buckets[1].median, 42, "and its value");
  const totalN = buckets.reduce((sum, b) => sum + b.n, 0);
  same(totalN, 1, "counted exactly once across all 288 buckets");
});

check("bucketSamples: 7d uses 168 one-hour buckets", () => {
  const buckets = bucketSamples([], RANGE_START, "7d");
  same(buckets.length, 168, "168 one-hour buckets over 7d");
});

check("bucketSamples: a sample outside the range window is dropped, not clamped into an edge bucket", () => {
  const samples = [{ atUtc: "2026-09-25T01:00:00.000Z", value: 5 }]; // more than 24h past start
  const buckets = bucketSamples(samples, RANGE_START, "24h");
  same(buckets.every((b) => b.n === 0), true, "not counted anywhere");
});

// ---------------------------------------------------------------------------
// Range validation
// ---------------------------------------------------------------------------

check("validateHistoryRange: '24h' and '7d' are ok", () => {
  same(validateHistoryRange("24h"), { kind: "ok", range: "24h" }, "24h");
  same(validateHistoryRange("7d"), { kind: "ok", range: "7d" }, "7d");
});

check("REQUIRED: any other range value is invalid (a 400), never silently coerced", () => {
  same(validateHistoryRange("24H").kind, "invalid", "wrong case");
  same(validateHistoryRange("1d").kind, "invalid", "not a supported range");
  same(validateHistoryRange(undefined).kind, "invalid", "missing entirely");
  same(validateHistoryRange(null).kind, "invalid", "null");
  same(validateHistoryRange("").kind, "invalid", "empty string");
});

// ---------------------------------------------------------------------------
// Run-length spans for the on/off strips, including "no samples"
// ---------------------------------------------------------------------------

const SPAN_START = "2026-09-24T00:00:00.000Z";
const SPAN_END = "2026-09-24T00:10:00.000Z"; // 10 minutes, 60s step -> 10 slots
const STEP_MS = 60_000;

check("buildStateSpans: an unbroken run of the same state coalesces into one span", () => {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    samples.push({ atUtc: new Date(Date.parse(SPAN_START) + i * STEP_MS).toISOString(), state: "on" });
  }
  const spans = buildStateSpans(samples, SPAN_START, SPAN_END, STEP_MS);
  same(spans, [{ fromUtc: SPAN_START, toUtc: SPAN_END, state: "on" }], "one span covering the whole range");
});

check("buildStateSpans: on -> off is two spans at the transition", () => {
  const samples = [
    { atUtc: "2026-09-24T00:00:00.000Z", state: "on" },
    { atUtc: "2026-09-24T00:01:00.000Z", state: "on" },
    { atUtc: "2026-09-24T00:02:00.000Z", state: "off" },
    { atUtc: "2026-09-24T00:03:00.000Z", state: "off" },
  ];
  const spans = buildStateSpans(samples, SPAN_START, "2026-09-24T00:04:00.000Z", STEP_MS);
  same(spans, [
    { fromUtc: "2026-09-24T00:00:00.000Z", toUtc: "2026-09-24T00:02:00.000Z", state: "on" },
    { fromUtc: "2026-09-24T00:02:00.000Z", toUtc: "2026-09-24T00:04:00.000Z", state: "off" },
  ], "two spans, split exactly at the transition");
});

check("REQUIRED, THE FEARED ONE: no samples at all is one 'no samples' span, never rendered as 'off'", () => {
  const spans = buildStateSpans([], SPAN_START, SPAN_END, STEP_MS);
  same(spans, [{ fromUtc: SPAN_START, toUtc: SPAN_END, state: "no samples" }], "the whole range is a gap, honestly labelled");
});

check("buildStateSpans: a gap between two samples (the API service was down) is 'no samples', not interpolated", () => {
  const samples = [
    { atUtc: "2026-09-24T00:00:00.000Z", state: "on" },
    // minutes 1-7 missing entirely: the sampler did not run
    { atUtc: "2026-09-24T00:08:00.000Z", state: "on" },
  ];
  const spans = buildStateSpans(samples, SPAN_START, SPAN_END, STEP_MS);
  same(spans, [
    { fromUtc: "2026-09-24T00:00:00.000Z", toUtc: "2026-09-24T00:01:00.000Z", state: "on" },
    { fromUtc: "2026-09-24T00:01:00.000Z", toUtc: "2026-09-24T00:08:00.000Z", state: "no samples" },
    { fromUtc: "2026-09-24T00:08:00.000Z", toUtc: "2026-09-24T00:09:00.000Z", state: "on" },
    // minute 9 (00:09-00:10) has no sample either -- its own honest gap, not
    // stretched onto the 00:08 sample's one-minute step.
    { fromUtc: "2026-09-24T00:09:00.000Z", toUtc: SPAN_END, state: "no samples" },
  ], "the gap is its own honestly-labelled span, and 'on' resumes rather than merging across it");
});

report("healthHistory");
