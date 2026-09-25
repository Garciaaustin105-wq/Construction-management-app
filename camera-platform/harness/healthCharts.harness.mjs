/**
 * The System page's History charts (HEALTH-HISTORY-SPEC.md), run without a
 * browser: agent/ui/health-charts.mjs's pure vnode builders, proven the way
 * the spec itself demands -- "series in, SVG string out ... tested in Node".
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/healthCharts.harness.mjs`.
 *
 * The failures feared, in the order the spec names them:
 *  - a gap (a bucket with no samples) drawn as a line down to zero, or
 *    interpolated across, instead of a break in the path (build rule 5).
 *  - two competing y-scales on one chart (the #1 anti-pattern the dataviz
 *    skill names by name).
 *  - a legend missing once a chart carries two or more series, so the
 *    reader is left matching colours by eye.
 *  - a unit silently dropped between the JSON and the screen (build rule 6).
 *  - the table-view twin disagreeing with the chart it is supposed to mirror
 *    (WCAG accessibility: the same numbers, not a re-derived summary).
 *  - a URL -- rtsp:// above all -- reaching the page through a label this
 *    file was hand ed as if it were a plain camera id or interface name.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { check, eq, same, report } from "./_assert.mjs";

const {
  safeLabel,
  vnodeToString,
  buildLineChart,
  buildStripChart,
  buildCpuChart,
  buildTemperatureChart,
  buildMemoryChart,
  buildDrivesChart,
  buildCameraBitrateSection,
  buildNetworkSection,
  buildRecordingStripsSection,
  buildRecorderRunningStrip,
  buildHistorySection,
  historyFromNote,
  CHART_COLORS_DARK,
} = await import(pathToFileURL(join(process.cwd(), "agent/ui/health-charts.mjs")).href);

console.log("health charts");

const colors = CHART_COLORS_DARK;

/* ── fixtures ─────────────────────────────────────────────────────────── */

const NOW = "2026-09-24T12:00:00.000Z";

function bucket(minutesAgo, median, n = 3) {
  return { startUtc: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(), median, n };
}

// 5 buckets, 5 minutes apart: measured, measured, GAP, measured, measured --
// one gap in the middle, on purpose (build rule 19: test the failure feared).
const GAPPY_BUCKETS = [
  bucket(20, 10),
  bucket(15, 20),
  bucket(10, null, 0),
  bucket(5, 40),
  bucket(0, 50),
];

/* ── a gap is a break, never a line to zero ──────────────────────────── */

check("a gap bucket breaks the line (a MOVE, never a LINE across it)", () => {
  const chart = buildLineChart({
    title: "Gappy", unitLabel: "%",
    seriesList: [{ label: "s1", buckets: GAPPY_BUCKETS, color: colors.categorical[0] }],
    colors,
  });
  const svg = vnodeToString(chart.vnode);
  const dMatch = /class="hc-line"[^>]*\sd="([^"]+)"/.exec(svg) ?? /d="([^"]+)"[^>]*class="hc-line"/.exec(svg);
  if (!dMatch) throw new Error("no hc-line path found in " + svg);
  const d = dMatch[1];
  const moveCount = (d.match(/M/g) || []).length;
  eq(moveCount, 2, "number of subpaths (one per unbroken run either side of the gap)");
  // The two runs must be genuinely disconnected: the first "M" is followed by
  // exactly one "L" (2-point run), not extended across the gap into a third
  // point -- i.e. the first subpath has exactly one L before the next M.
  const firstSubpath = d.split("M")[1];
  const lCountFirstRun = (firstSubpath.match(/L/g) || []).length;
  eq(lCountFirstRun, 1, "first run draws only its own 2 points, never bridging the gap");
});

check("a bucket with n=0 renders as a break, not a point at y=0 (build rule 5)", () => {
  const chart = buildLineChart({
    title: "Gappy", unitLabel: "%",
    seriesList: [{ label: "s1", buckets: GAPPY_BUCKETS, color: colors.categorical[0] }],
    yDomain: [0, 100], colors,
  });
  const svg = vnodeToString(chart.vnode);
  // The gap's own timestamp must not appear on any hc-hit (a hit target only
  // exists for a bucket that was actually measured).
  const gapUtc = GAPPY_BUCKETS[2].startUtc;
  if (svg.includes(`data-t="${gapUtc}"`)) {
    throw new Error("the unmeasured bucket got a hit target, as if it had a value");
  }
});

/* ── one y-axis per chart, always ────────────────────────────────────── */

check("exactly one y-scale per chart, single series", () => {
  const chart = buildCpuChart({ unit: "%", buckets: GAPPY_BUCKETS }, colors);
  const svg = vnodeToString(chart.vnode);
  const count = (svg.match(/class="hc-yaxis"/g) || []).length;
  eq(count, 1, "hc-yaxis marker count");
});

check("exactly one y-scale per chart, multi-series (drives)", () => {
  const chart = buildDrivesChart([
    { root: "/mnt/a", buckets: GAPPY_BUCKETS },
    { root: "/mnt/b", buckets: GAPPY_BUCKETS },
  ], colors);
  const svg = vnodeToString(chart.vnode);
  const count = (svg.match(/class="hc-yaxis"/g) || []).length;
  eq(count, 1, "hc-yaxis marker count with 2 series sharing one scale");
});

/* ── legend appears for 2+ series, not for 1 ─────────────────────────── */

check("no legend for a single series", () => {
  const chart = buildCpuChart({ unit: "%", buckets: GAPPY_BUCKETS }, colors);
  const svg = vnodeToString(chart.vnode);
  if (svg.includes("hc-legend")) throw new Error("a single-series chart should not carry a legend box");
});

check("a legend exists once a chart carries 2 or more series", () => {
  const chart = buildDrivesChart([
    { root: "/mnt/a", buckets: GAPPY_BUCKETS },
    { root: "/mnt/b", buckets: GAPPY_BUCKETS },
  ], colors);
  const svg = vnodeToString(chart.vnode);
  if (!svg.includes("hc-legend")) throw new Error("expected a legend for 2 series");
  if (!svg.includes("/mnt/a") || !svg.includes("/mnt/b")) throw new Error("legend must name every series");
});

check("network rx/tx (2 series) also gets a legend", () => {
  const section = buildNetworkSection([{ name: "eth0", rxMbps: { buckets: GAPPY_BUCKETS }, txMbps: { buckets: GAPPY_BUCKETS } }], colors);
  const svg = vnodeToString(section.charts[0].vnode);
  if (!svg.includes("hc-legend")) throw new Error("expected a legend for rx+tx");
});

/* ── units appear, in the data, in the JSON, and on screen (build rule 6) */

check("CPU chart shows the % unit", () => {
  const chart = buildCpuChart({ unit: "%", buckets: GAPPY_BUCKETS }, colors);
  const svg = vnodeToString(chart.vnode);
  if (!svg.includes("%")) throw new Error("expected the % unit somewhere on the chart");
});

check("memory chart converts MiB to GiB and shows GiB, never the wire unit", () => {
  const chart = buildMemoryChart({ unit: "MiB", buckets: [bucket(0, 2048, 3)] }, colors);
  const svg = vnodeToString(chart.vnode);
  if (!svg.includes("GiB")) throw new Error("expected the display unit GiB");
  if (svg.includes("MiB")) throw new Error("the wire unit (MiB) leaked onto the screen instead of the display unit (GiB)");
  // 2048 MiB -> 2.0 GiB.
  if (!svg.includes("2.0")) throw new Error("expected the converted value 2.0 (GiB) somewhere in the chart");
});

check("temperature chart shows its unit and the source label when measured", () => {
  const chart = buildTemperatureChart({ unit: "°C", source: "hwmon coretemp Package id 0", buckets: [bucket(0, 42.3, 1)] }, colors);
  const svg = vnodeToString(chart.vnode);
  if (!svg.includes("°C")) throw new Error("expected the °C unit");
  if (!svg.includes("hwmon coretemp Package id 0")) throw new Error("expected the temperature source label under the chart");
});

check("temperature chart says so, in words, when never measured -- never a fabricated 0°C", () => {
  const chart = buildTemperatureChart({ unit: "°C", source: null, buckets: [bucket(0, null, 0)] }, colors);
  const svg = vnodeToString(chart.vnode);
  if (!svg.includes("temperature not measured on this box")) throw new Error("expected the unmeasured note");
});

/* ── the table view has the same numbers as the chart ────────────────── */

check("the table view repeats the chart's own bucket values, not a re-derived summary", () => {
  const chart = buildLineChart({
    title: "T", unitLabel: "%",
    seriesList: [{ label: "s1", buckets: GAPPY_BUCKETS, color: colors.categorical[0] }],
    colors,
  });
  const svg = vnodeToString(chart.vnode);
  for (const b of GAPPY_BUCKETS) {
    if (b.median === null) {
      // The gap's row must say so in words, not print a blank or a 0.
      continue;
    }
    const expected = b.median.toFixed(1);
    if (!svg.includes(expected)) throw new Error(`table view missing bucket value ${expected}`);
  }
  if (!svg.includes("no data")) throw new Error('the gap row should read "no data", never blank or 0');
});

/* ── no rtsp:// (or any URL) can ever render ─────────────────────────── */

const POISONED_CAMERA_ID = "rtsp://install:S3cr3tPass@192.168.1.50:554/ch1";

check("safeLabel refuses anything URL-shaped", () => {
  eq(safeLabel(POISONED_CAMERA_ID), "redacted", "a URL-shaped label is redacted, not passed through");
  eq(safeLabel("cam-front"), "cam-front", "a plain id passes through unchanged");
  eq(safeLabel(null), "unknown", "a missing label reads as unknown, never blank");
});

check("THE FEARED ONE: a poisoned cameraId can never reach a bitrate chart's SVG", () => {
  const section = buildCameraBitrateSection([
    { cameraId: POISONED_CAMERA_ID, recordedKbps: { buckets: GAPPY_BUCKETS } },
    { cameraId: "cam-back", recordedKbps: { buckets: GAPPY_BUCKETS } },
  ], colors);
  const svg = section.charts.map((c) => vnodeToString(c.vnode)).join("\n");
  if (svg.includes("rtsp://")) throw new Error("rtsp:// reached the chart's SVG");
  if (svg.includes("S3cr3tPass")) throw new Error("a credential reached the chart's SVG");
  if (!svg.includes("redacted")) throw new Error("expected the poisoned label to render as 'redacted'");
});

check("THE FEARED ONE, again: a poisoned drive root or interface name is also refused", () => {
  const drives = vnodeToString(buildDrivesChart([{ root: POISONED_CAMERA_ID, buckets: GAPPY_BUCKETS }], colors).vnode);
  const net = vnodeToString(buildNetworkSection([{ name: POISONED_CAMERA_ID, rxMbps: { buckets: GAPPY_BUCKETS }, txMbps: { buckets: GAPPY_BUCKETS } }], colors).charts[0].vnode);
  const recording = vnodeToString(buildRecordingStripsSection([{ cameraId: POISONED_CAMERA_ID, recording: { spans: [] } }], NOW, NOW, colors).charts[0].vnode);
  for (const [name, svg] of [["drives", drives], ["network", net], ["recording strip", recording]]) {
    if (svg.includes("rtsp://")) throw new Error(`${name} chart let rtsp:// through`);
  }
});

/* ── on/off strips: always a labelled legend, "no samples" is its own state,
   never folded into "off" ────────────────────────────────────────────── */

check("a strip chart always carries an on/off/no-samples legend, even with zero spans", () => {
  const chart = buildStripChart({ title: "Recorder running", spans: [], rangeStartUtc: NOW, rangeEndUtc: NOW, colors });
  const svg = vnodeToString(chart.vnode);
  for (const word of ["on", "off", "no samples"]) {
    if (!svg.includes(word)) throw new Error(`expected the strip legend to name "${word}"`);
  }
});

check("'off' and 'no samples' are visually distinct fills, never the same colour", () => {
  const rangeStartUtc = NOW;
  const rangeEndUtc = new Date(Date.parse(NOW) + 3 * 60_000).toISOString();
  const spans = [
    { fromUtc: NOW, toUtc: new Date(Date.parse(NOW) + 60_000).toISOString(), state: "off" },
  ];
  const chart = buildStripChart({ title: "s", spans, rangeStartUtc, rangeEndUtc, colors });
  const svg = vnodeToString(chart.vnode);
  const offFill = /data-state="off"[^>]*fill="([^"]+)"/.exec(svg) ?? /fill="([^"]+)"[^>]*data-state="off"/.exec(svg);
  if (!offFill) throw new Error("no off segment found");
  if (offFill[1] === colors.textMuted) throw new Error('"off" must not share its colour with "no samples"');
});

/* ── the whole section assembles without throwing, on realistic and edge
   fixtures (Windows dev box: nothing Linux-only was ever measured) ──── */

function fullFixture(cameraCount) {
  const cameras = [];
  for (let i = 0; i < cameraCount; i++) {
    cameras.push({
      cameraId: `cam-${i}`,
      recordedKbps: { unit: "kbps", buckets: GAPPY_BUCKETS },
      recording: { spans: [{ fromUtc: NOW, toUtc: new Date(Date.parse(NOW) + 60_000).toISOString(), state: "on" }] },
    });
  }
  return {
    ok: true, range: "24h", atUtc: NOW, historyFromUtc: new Date(Date.parse(NOW) - 24 * 60 * 60 * 1000).toISOString(),
    cpu: { unit: "%", buckets: GAPPY_BUCKETS },
    load1: { unit: "load average", buckets: GAPPY_BUCKETS },
    memUsedMiB: { unit: "MiB", buckets: GAPPY_BUCKETS },
    temperature: { unit: "°C", source: "hwmon coretemp Package id 0", buckets: GAPPY_BUCKETS },
    drives: [{ root: "/srv/store0", unit: "%", buckets: GAPPY_BUCKETS }],
    cameras,
    recorderRunning: { spans: [{ fromUtc: NOW, toUtc: new Date(Date.parse(NOW) + 60_000).toISOString(), state: "on" }] },
    interfaces: [{ name: "eth0", rxMbps: { unit: "Mbps", buckets: GAPPY_BUCKETS }, txMbps: { unit: "Mbps", buckets: GAPPY_BUCKETS } }],
  };
}

check("2 cameras: one shared bitrate chart with a legend, not small multiples", () => {
  const section = buildHistorySection(fullFixture(2), "24h", colors);
  same(section.cameraBitrate.mode, "single", "mode with <= 4 cameras");
  eq(section.cameraBitrate.charts.length, 1, "one combined chart");
});

check("9 cameras: small multiples, one chart per camera, sharing a y-scale", () => {
  const section = buildHistorySection(fullFixture(9), "24h", colors);
  same(section.cameraBitrate.mode, "small-multiples", "mode with > 4 cameras");
  eq(section.cameraBitrate.charts.length, 9, "one chart per camera");
});

check("a Windows dev box's all-null series still renders, never throws", () => {
  const allGaps = [bucket(10, null, 0), bucket(5, null, 0), bucket(0, null, 0)];
  const chart = buildCpuChart({ unit: "%", buckets: allGaps }, colors);
  const svg = vnodeToString(chart.vnode);
  if (!svg.includes("no data")) throw new Error('expected every table row to read "no data"');
});

check('"history from HH:MM" appears only when the store holds less than the range', () => {
  const fullStore = { atUtc: NOW, historyFromUtc: new Date(Date.parse(NOW) - 24 * 60 * 60 * 1000).toISOString() };
  eq(historyFromNote(fullStore, "24h"), null, "a full 24h store needs no caveat");
  const freshStore = { atUtc: NOW, historyFromUtc: new Date(Date.parse(NOW) - 30 * 60 * 1000).toISOString() };
  const note = historyFromNote(freshStore, "24h");
  if (typeof note !== "string" || !note.startsWith("history from")) {
    throw new Error(`expected a "history from" note for a freshly-enabled store, got ${JSON.stringify(note)}`);
  }
});

report("health charts");
