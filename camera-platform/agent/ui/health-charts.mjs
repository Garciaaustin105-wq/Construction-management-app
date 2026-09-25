// agent/ui/health-charts.mjs
//
// The System page's "History" section (HEALTH-HISTORY-SPEC.md): CPU,
// temperature, memory, drives, per-camera bitrate, network, and the
// recording/recorder-running strips, over 24h or 7d. Reads GET
// /health/history's JSON (contracts/healthHistory.ts's Bucket/StripSpan
// shapes, unchanged) and turns it into charts.
//
// Code shape, per the spec verbatim: "chart markup is built by a pure
// function (series in, SVG string out) so it can be tested in Node and saved
// as files to look at." This file keeps that contract two ways from ONE
// shared computation:
//   - every builder below (buildLineChart, buildStripChart, and the
//     per-metric wrappers) returns a small "vnode" tree (plain objects:
//     {tag, attrs, children, text}) plus the geometry it computed. Nothing
//     here touches a DOM, a clock or the network -- pure data in, a
//     description of markup out.
//   - `vnodeToString` serialises that tree to an SVG/HTML string (the
//     harness's own read, and what the scratch preview script saves to
//     disk).
//   - `vnodeToDom` walks the SAME tree into real nodes via
//     doc.createElement/createElementNS -- what agent/ui/system-client.mjs
//     mounts on the live page. Building both renderers from one tree means
//     the live page never calls innerHTML (this directory's own house rule --
//     see network-client.mjs's and system-client.mjs's own comments) while
//     still giving the harness and the reviewer's static preview a plain
//     string.
//
// House rules this file is written against, same as every other *-client.mjs
// here: a blank bucket (median: null) is a BREAK in the line, never a point
// at 0 (build rule 5) -- see pathD's per-run "M", never a single unbroken "L"
// run across a gap. A series' label is untrusted-ish text (a camera id, an
// interface name, a temperature-source string) that ultimately comes from a
// config file or a sensor driver's own name, not something this file may
// trust as markup or as safe to show verbatim: `safeLabel` below refuses
// (never guesses) anything that looks like a URL -- the spec's own words,
// "No credential, URL or rtsp:// may ever enter ... the page" -- and every
// piece of text this file emits goes through the same escaping in
// `vnodeToString`/`vnodeToDom`'s text-node path, never string concatenation
// into markup.

const SVG_NS = "http://www.w3.org/2000/svg";
const NOT_MEASURED = "not measured";

// Anything that looks like a URL (rtsp://, http://, or any other scheme) is
// refused outright and shown as "redacted" -- never guessed at, never passed
// through partially. This file has no legitimate reason to ever receive one
// (every real label is a bare cameraId, interface name, store root, or the
// fixed temperature-source strings contracts/healthHistory.ts's
// chooseTempSource returns), so a value that matches this pattern is treated
// as a bug upstream, not a string to render.
const URL_LIKE = /:\/\//;

/** A label this file may print: a string, with anything URL-shaped redacted
 *  and anything not a string (or empty) shown as "unknown" -- never blank,
 *  which would look like the chart forgot to load rather than tell the
 *  reader something is wrong with the label itself. */
export function safeLabel(value) {
  if (typeof value !== "string" || value === "") return "unknown";
  return URL_LIKE.test(value) ? "redacted" : value;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/* ── the vnode tree: plain data describing markup, nothing else ─────────── */

function h(tag, attrs = {}, children = [], text = null) {
  return { tag, attrs, children, text };
}

// Tags this file ever emits that belong in the SVG namespace when built as
// real DOM. Everything else (div, table, details, span, ...) is plain HTML.
const SVG_TAGS = new Set(["svg", "g", "path", "line", "circle", "rect", "text", "polyline"]);

// SVG/XML has no HTML-style "void" element shorthand requirement, but the
// marks this file draws (rect/circle/line/path) never have children or text,
// so self-closing them keeps the string smaller and easier to read when
// saved to a preview file.
const SELF_CLOSING = new Set(["rect", "circle", "line", "path", "polyline"]);

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The pure renderer the spec asks for: a vnode tree -> one SVG/HTML string.
 *  Every attribute value and every text node is escaped -- the only place
 *  dynamic text (a label, a formatted number) ever reaches a string, so a
 *  camera id containing '<' or '&' cannot break out of its element. */
export function vnodeToString(node) {
  if (node === null || node === undefined) return "";
  if (node.tag === "#text") return escapeXml(node.text ?? "");
  const attrs = Object.entries(node.attrs || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${escapeXml(v === true ? "" : v)}"`)
    .join("");
  const kids = (node.children || []).map(vnodeToString).join("");
  const text = node.text !== null && node.text !== undefined ? escapeXml(node.text) : "";
  if (!kids && !text && SELF_CLOSING.has(node.tag)) {
    return `<${node.tag}${attrs}/>`;
  }
  return `<${node.tag}${attrs}>${text}${kids}</${node.tag}>`;
}

/** The live-page renderer: the SAME vnode tree, built as real nodes via
 *  createElement/createElementNS -- never innerHTML (this directory's own
 *  house rule; see network-client.mjs and system-client.mjs). `doc` and the
 *  namespace decision are the only DOM surface this file touches. */
export function vnodeToDom(doc, node) {
  if (node === null || node === undefined) return null;
  if (node.tag === "#text") return doc.createTextNode(node.text ?? "");
  const el = SVG_TAGS.has(node.tag) ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof el.setAttribute === "function") {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (node.text !== null && node.text !== undefined) {
    el.appendChild(doc.createTextNode(node.text));
  }
  for (const child of node.children || []) {
    const childEl = vnodeToDom(doc, child);
    if (childEl) el.appendChild(childEl);
  }
  return el;
}

/* ── colour: the dataviz skill's categorical order, mapped onto this page's
   own tokens (system.html's --good/--warn/--bad chip colours for the on/off
   strips; the skill's validated categorical hues -- run through
   scripts/validate_palette.js against this page's own surfaces, see the
   report handed back with this file -- for every line series). Never
   cycled past 8; a 9th series folds into small multiples rather than a
   generated hue (dataviz anti-patterns.md). ─────────────────────────────── */

export const CHART_COLORS_DARK = Object.freeze({
  surface: "#1b1d22",
  grid: "#2c2f36",
  textPrimary: "#e8eaed",
  textMuted: "#9aa0a6",
  good: "#7ddc9a",
  warn: "#f1e3a0",
  bad: "#ffb4b4",
  categorical: Object.freeze(["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]),
});

export const CHART_COLORS_LIGHT = Object.freeze({
  surface: "#fcfcfb",
  grid: "#e1e0d9",
  textPrimary: "#0b0b0b",
  textMuted: "#52514e",
  good: "#0ca30c",
  warn: "#fab219",
  bad: "#d03b3b",
  categorical: Object.freeze(["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]),
});

/* ── small formatting helpers ─────────────────────────────────────────── */

function round(n) {
  return Math.round(n * 100) / 100;
}

// >=100 -> a whole number (an axis full of "42.3, 58.7, 100.0" reads noisier
// than "42, 59, 100" once the range is that wide); below it, one decimal.
function formatNum(n) {
  if (!isNum(n)) return NOT_MEASURED;
  return Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(1);
}

const two = (n) => String(n).padStart(2, "0");

/** Local wall-clock "HH:MM" for a UTC ISO string -- same convention as every
 *  other page in this family (system-client.mjs, network-client.mjs). */
export function localTimeUtc(utc) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return String(utc);
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

/** Rounds a positive value up to a "nice" axis ceiling (1/2/5 x 10^n) -- the
 *  same family of rounding an axis library uses so ticks read as 20/40/60
 *  rather than 37/74/111. Never applied to CPU% or a drive's used%, which
 *  the spec fixes at 0-100 regardless of the data (build rule 12: this file
 *  reports measurements, it does not decide what "full" means). */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const norm = v / magnitude;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * magnitude;
}

function yDomainFromSeries(seriesList) {
  const values = [];
  for (const s of seriesList) {
    for (const b of s.buckets ?? []) {
      if (b && isNum(b.median)) values.push(b.median);
    }
  }
  if (values.length === 0) return [0, 1];
  const max = Math.max(...values);
  const min = Math.min(0, Math.min(...values));
  const ceiling = niceMax(max - min || max || 1);
  return [min, min + ceiling];
}

/* ── line charts: one y-axis, medians as points, gaps as breaks ─────────── */

const LINE_PAD = { left: 46, right: 12, top: 20, bottom: 24 };

function computeLineLayout({ seriesList, yDomain, width, height }) {
  const plotW = width - LINE_PAD.left - LINE_PAD.right;
  const plotH = height - LINE_PAD.top - LINE_PAD.bottom;
  const count = Math.max(0, ...seriesList.map((s) => (s.buckets ?? []).length));
  const [yMin, yMax] = yDomain ?? yDomainFromSeries(seriesList);
  const xAt = (i) => LINE_PAD.left + (count > 1 ? (i / (count - 1)) * plotW : plotW / 2);
  const yAt = (v) => LINE_PAD.top + (yMax === yMin ? plotH / 2 : (1 - (v - yMin) / (yMax - yMin)) * plotH);

  const series = seriesList.map((s, seriesIndex) => {
    const buckets = Array.isArray(s.buckets) ? s.buckets : [];
    const runs = [];
    let current = [];
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b && isNum(b.median)) {
        current.push({ x: xAt(i), y: yAt(b.median), startUtc: b.startUtc, median: b.median, n: b.n });
      } else if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length > 0) runs.push(current);
    const lastPoint = runs.length > 0 ? runs[runs.length - 1][runs[runs.length - 1].length - 1] : null;
    return { label: safeLabel(s.label), color: s.color, buckets, runs, lastPoint, seriesIndex };
  });

  return { width, height, yMin, yMax, plotW, plotH, series };
}

/** `d` for one series' <path>: one "M" per run (per unbroken stretch of
 *  measured buckets), so a gap between two runs is a MOVE, never a LINE
 *  drawn across the missing minutes at some interpolated or zero height
 *  (build rule 5, this file's own feared failure). A lone one-point run
 *  draws no visible line at all (a path needs two points), which is why
 *  seriesVNodes below also drops a dot on every single-point run. */
function pathD(runs) {
  return runs
    .filter((run) => run.length > 0)
    .map((run) => {
      const [first, ...rest] = run;
      const line = rest.map((p) => `L${round(p.x)},${round(p.y)}`).join("");
      return `M${round(first.x)},${round(first.y)}${line}`;
    })
    .join(" ");
}

function yAxisVNodes(layout, colors, unitLabel) {
  const ticks = [layout.yMin, (layout.yMin + layout.yMax) / 2, layout.yMax];
  const nodes = [];
  for (const t of ticks) {
    const y = round(LINE_PAD.top + (layout.yMax === layout.yMin ? layout.plotH / 2 : (1 - (t - layout.yMin) / (layout.yMax - layout.yMin)) * layout.plotH));
    nodes.push(h("line", {
      x1: LINE_PAD.left, x2: layout.width - LINE_PAD.right, y1: y, y2: y,
      stroke: colors.grid, "stroke-width": "1", class: "hc-grid",
    }));
    nodes.push(h("text", {
      x: LINE_PAD.left - 6, y: y + 3, "text-anchor": "end", fill: colors.textMuted, "font-size": "10",
    }, [], formatNum(t)));
  }
  // Exactly one of these per chart -- the harness's own proof that a chart
  // never grows a second, competing y-scale (spec: "One y-axis per chart,
  // always ... never one chart with two scales").
  nodes.push(h("text", {
    x: 2, y: 11, class: "hc-yaxis", fill: colors.textMuted, "font-size": "10",
  }, [], unitLabel));
  return nodes;
}

/**
 * Where each series' end label actually lands, after separating any that
 * would otherwise overlap. Two lines converging toward the same value at
 * "now" -- exactly what a healthy pair of cameras/drives tends to do -- put
 * their raw label positions within a few px of each other; printing both
 * there is unreadable, and marks-and-anatomy.md's own guidance for that case
 * ("nudging labels apart... leader lines") is what this does: labels are
 * pushed apart to a minimum vertical gap, keeping their original (x, y) as
 * `anchorX`/`anchorY` so a short leader line can still connect a nudged
 * label back to its own dot.
 */
function computeEndLabelLayout(series) {
  const MIN_GAP = 12;
  const items = series
    .filter((s) => s.lastPoint)
    .map((s) => ({
      seriesIndex: s.seriesIndex, color: s.color,
      text: `${s.label} ${formatNum(s.lastPoint.median)}`,
      x: s.lastPoint.x, anchorX: s.lastPoint.x, anchorY: s.lastPoint.y, y: s.lastPoint.y,
    }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y < MIN_GAP) {
      items[i].y = items[i - 1].y + MIN_GAP;
    }
  }
  const byIndex = new Map();
  for (const it of items) byIndex.set(it.seriesIndex, it);
  return byIndex;
}

function seriesVNodes(s, colors, opts) {
  const nodes = [];
  const d = pathD(s.runs);
  if (d) {
    nodes.push(h("path", {
      d, fill: "none", stroke: s.color, "stroke-width": "2",
      "stroke-linejoin": "round", "stroke-linecap": "round", class: "hc-line",
    }));
  }
  // A run of exactly one measured bucket has no line to draw (a path needs
  // two points) -- without this dot, one good reading surrounded by gaps
  // would be invisible, which looks identical to "never measured".
  for (const run of s.runs) {
    if (run.length === 1) {
      nodes.push(h("circle", { cx: round(run[0].x), cy: round(run[0].y), r: "3", fill: s.color }));
    }
  }
  // Invisible hit targets for the crosshair/tooltip (interaction.md: "the
  // hit target is bigger than the mark"). One per measured bucket, carrying
  // the reading's own time/value/n as data-* -- the tooltip and the table
  // view read the same numbers this way, never a re-derived copy.
  for (const run of s.runs) {
    for (const p of run) {
      nodes.push(h("circle", {
        cx: round(p.x), cy: round(p.y), r: "10", fill: "transparent", class: "hc-hit",
        "data-series": s.label, "data-t": p.startUtc, "data-v": String(p.median), "data-n": String(p.n),
      }));
    }
  }
  if (s.lastPoint) {
    nodes.push(h("circle", {
      cx: round(s.lastPoint.x), cy: round(s.lastPoint.y), r: "4", fill: s.color,
      stroke: colors.surface, "stroke-width": "2",
    }));
  }
  const label = opts.endLabelPos;
  if (label) {
    const nudged = Math.abs(label.y - label.anchorY) > 2;
    if (nudged) {
      // A short leader line back to the dot it belongs to, so a reader can
      // still tell which nudged label is whose (marks-and-anatomy.md).
      nodes.push(h("line", {
        x1: round(label.anchorX), y1: round(label.anchorY),
        x2: round(label.x) - (opts.rightAlignEndLabel ? 8 : -2), y2: round(label.y),
        stroke: label.color, "stroke-width": "1", "stroke-dasharray": "2,2", class: "hc-leader",
      }));
    }
    nodes.push(h("text", {
      x: round(label.x) - (opts.rightAlignEndLabel ? 4 : -6),
      y: round(label.y) + 3,
      "text-anchor": opts.rightAlignEndLabel ? "end" : "start",
      "font-size": "10", fill: colors.textMuted, class: "hc-endlabel",
    }, [], label.text));
  }
  return nodes;
}

function legendVNode(seriesList, colors) {
  if (seriesList.length < 2) return null; // a single series names itself in the title (marks-and-anatomy.md).
  return h("div", { class: "hc-legend" }, seriesList.map((s) => h("span", { class: "hc-legend-item" }, [
    h("span", { class: "hc-swatch", style: `background:${s.color}` }),
    h("span", {}, [], s.label),
  ])));
}

function lineTableVNode(seriesList, unitLabel) {
  const count = Math.max(0, ...seriesList.map((s) => (s.buckets ?? []).length));
  const head = h("tr", {}, [
    h("th", {}, [], "Time"),
    ...seriesList.map((s) => h("th", {}, [], seriesList.length > 1 ? `${s.label} (${unitLabel})` : unitLabel)),
  ]);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const timeCell = seriesList[0]?.buckets?.[i]?.startUtc;
    const cells = [h("td", {}, [], timeCell ? localTimeUtc(timeCell) : "")];
    for (const s of seriesList) {
      const b = s.buckets?.[i];
      const text = b && isNum(b.median) ? `${formatNum(b.median)} (n=${b.n})` : "no data";
      cells.push(h("td", {}, [], text));
    }
    rows.push(h("tr", {}, cells));
  }
  return h("details", { class: "hc-table-toggle" }, [
    h("summary", {}, [], "Table view"),
    h("table", { class: "hc-table" }, [h("thead", {}, [head]), h("tbody", {}, rows)]),
  ]);
}

/**
 * One line chart: one y-axis (spec: "One y-axis per chart, always"), a
 * legend when there are 2+ series, direct end labels when there are few
 * enough series for them to stay legible (spec: "up to 4 cameras, one chart
 * with a legend and direct end labels"), and a table-view twin with the same
 * numbers (WCAG accessibility, and this file's own harness proof).
 *
 * `seriesList`: [{ label, color, buckets: [{startUtc, median, n}] }].
 * `yDomain`: an explicit [min, max] (CPU%/drive% fix 0-100); omitted, this
 * computes one from the data with headroom.
 */
export function buildLineChart({ title, unitLabel, seriesList, yDomain, colors, width = 640, height = 200, note, endLabels }) {
  const list = Array.isArray(seriesList) ? seriesList : [];
  const layout = computeLineLayout({ seriesList: list, yDomain, width, height });
  const wantEndLabels = endLabels ?? list.length <= 4;
  const axisNodes = yAxisVNodes(layout, colors, unitLabel);
  // Every series here is a time run ending "now", so its last point always
  // sits at the plot's right edge -- an end label growing rightward from it
  // would run straight off the viewBox and clip (marks-and-anatomy.md's own
  // "a label that won't fit doesn't get clipped" rule). Anchoring it to grow
  // LEFTWARD, back into the plot, keeps it on screen without measuring text
  // width by hand.
  const endLabelLayout = wantEndLabels ? computeEndLabelLayout(layout.series) : new Map();
  const seriesNodes = layout.series.flatMap((s) => seriesVNodes(s, colors, {
    rightAlignEndLabel: true, endLabelPos: endLabelLayout.get(s.seriesIndex) ?? null,
  }));
  const seriesDescription = layout.series.map((s) => s.label).join(", ") || "no data";
  const svg = h("svg", {
    viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "hc-svg", role: "img",
    "aria-label": `${title}, in ${unitLabel}: ${seriesDescription}`,
  }, [h("g", { class: "hc-axis" }, axisNodes), ...seriesNodes]);
  const legend = legendVNode(layout.series, colors);
  const noteVNode = note ? h("div", { class: "hc-note dim" }, [], note) : null;
  const table = lineTableVNode(layout.series, unitLabel);
  return {
    title,
    unitLabel,
    layout,
    vnode: h("div", { class: "hc-chart" }, [
      h("div", { class: "hc-title" }, [], title),
      svg,
      ...(legend ? [legend] : []),
      ...(noteVNode ? [noteVNode] : []),
      table,
    ]),
  };
}

/* ── strip charts: on/off/no-samples run-length spans, never a line ─────── */

const STRIP_PAD = { left: 0, right: 0, top: 6, bottom: 0 };

function stripStateColor(state, colors) {
  if (state === "on") return colors.good;
  if (state === "off") return colors.bad;
  return colors.textMuted; // "no samples": a gap, drawn distinct from "off" (build rule 5).
}

function computeStripLayout({ spans, rangeStartUtc, rangeEndUtc, width, height }) {
  const startMs = Date.parse(rangeStartUtc);
  const endMs = Date.parse(rangeEndUtc);
  const span = endMs - startMs;
  const barH = height - STRIP_PAD.top - STRIP_PAD.bottom;
  const rects = (Array.isArray(spans) ? spans : []).map((s) => {
    const fromMs = Date.parse(s.fromUtc);
    const toMs = Date.parse(s.toUtc);
    const x = span > 0 ? ((fromMs - startMs) / span) * width : 0;
    const w = span > 0 ? Math.max(1, ((toMs - fromMs) / span) * width) : width;
    return { x, w, state: s.state, fromUtc: s.fromUtc, toUtc: s.toUtc };
  });
  return { width, height, barH, rects };
}

/**
 * One on/off/no-samples strip (spec: "Drawn as a strip, not a line"). Always
 * carries a legend -- the spec's own words, "on/off strips carry labels":
 * colour alone is never how this file lets a status be read.
 */
export function buildStripChart({ title, spans, rangeStartUtc, rangeEndUtc, colors, width = 640, height = 28 }) {
  const layout = computeStripLayout({ spans, rangeStartUtc, rangeEndUtc, width, height });
  const rectNodes = layout.rects.map((r) => h("rect", {
    x: round(r.x), y: STRIP_PAD.top, width: round(Math.max(0, r.w)), height: layout.barH,
    fill: stripStateColor(r.state, colors), class: "hc-strip-seg",
    "data-state": r.state, "data-from": r.fromUtc, "data-to": r.toUtc,
  }));
  const svg = h("svg", {
    viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "hc-svg hc-strip-svg", role: "img",
    "aria-label": `${title}: on, off, or no samples over time`,
  }, rectNodes);
  const legend = h("div", { class: "hc-legend" }, [
    h("span", { class: "hc-legend-item" }, [h("span", { class: "hc-swatch", style: `background:${colors.good}` }), h("span", {}, [], "on")]),
    h("span", { class: "hc-legend-item" }, [h("span", { class: "hc-swatch", style: `background:${colors.bad}` }), h("span", {}, [], "off")]),
    h("span", { class: "hc-legend-item" }, [h("span", { class: "hc-swatch", style: `background:${colors.textMuted}` }), h("span", {}, [], "no samples")]),
  ]);
  const rows = layout.rects.map((r) => h("tr", {}, [
    h("td", {}, [], localTimeUtc(r.fromUtc)),
    h("td", {}, [], localTimeUtc(r.toUtc)),
    h("td", {}, [], r.state),
  ]));
  const table = h("details", { class: "hc-table-toggle" }, [
    h("summary", {}, [], "Table view"),
    h("table", { class: "hc-table" }, [
      h("thead", {}, [h("tr", {}, [h("th", {}, [], "From"), h("th", {}, [], "To"), h("th", {}, [], "State")])]),
      h("tbody", {}, rows),
    ]),
  ]);
  return {
    title,
    layout,
    vnode: h("div", { class: "hc-chart hc-strip" }, [
      h("div", { class: "hc-title" }, [], title),
      svg,
      legend,
      table,
    ]),
  };
}

/* ── per-metric composites: the exact chart list HEALTH-HISTORY-SPEC.md gives */

const RANGE_WINDOW_MS = Object.freeze({ "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000 });
const SMALL_MULTIPLE_THRESHOLD = 4;

export function buildCpuChart(cpu, colors) {
  return buildLineChart({
    title: "CPU", unitLabel: (cpu && cpu.unit) || "%",
    seriesList: [{ label: "CPU", buckets: cpu?.buckets ?? [], color: colors.categorical[0] }],
    yDomain: [0, 100], colors, endLabels: true,
  });
}

export function buildTemperatureChart(temperature, colors) {
  const note = temperature && typeof temperature.source === "string" && temperature.source
    ? `source: ${safeLabel(temperature.source)}`
    : "temperature not measured on this box";
  return buildLineChart({
    title: "Temperature", unitLabel: (temperature && temperature.unit) || "°C",
    seriesList: [{ label: "Temperature", buckets: temperature?.buckets ?? [], color: colors.categorical[0] }],
    colors, note, endLabels: true,
  });
}

/** MiB -> GiB, per the spec's own words ("Memory used, in GiB") -- the wire
 *  unit (MiB, contracts/healthHistory.ts's own choice, sized for a minute's
 *  worth of RSS delta) is not the display unit, and n/startUtc ride along
 *  unchanged so the table view still shows the real sample count. */
export function buildMemoryChart(memUsedMiB, colors) {
  const gibBuckets = (memUsedMiB?.buckets ?? []).map((b) => ({
    startUtc: b.startUtc, n: b.n, median: isNum(b.median) ? b.median / 1024 : null,
  }));
  return buildLineChart({
    title: "Memory used", unitLabel: "GiB",
    seriesList: [{ label: "Memory used", buckets: gibBuckets, color: colors.categorical[0] }],
    colors, endLabels: true,
  });
}

export function buildDrivesChart(drives, colors) {
  const list = Array.isArray(drives) ? drives : [];
  return buildLineChart({
    title: "Drives (used %)", unitLabel: "%",
    seriesList: list.map((d, i) => ({
      label: safeLabel(d.root), buckets: d.buckets ?? [], color: colors.categorical[i % colors.categorical.length],
    })),
    yDomain: [0, 100], colors,
  });
}

function sharedYDomainForBuckets(bucketArrays) {
  const values = [];
  for (const buckets of bucketArrays) {
    for (const b of buckets) if (b && isNum(b.median)) values.push(b.median);
  }
  if (values.length === 0) return [0, 1];
  return [0, niceMax(Math.max(...values))];
}

/**
 * Camera bitrate (spec: "up to 4 cameras, one chart with a legend and direct
 * end labels. With more, small multiples: one small chart per camera on a
 * shared y-scale.").
 */
export function buildCameraBitrateSection(cameras, colors) {
  const list = Array.isArray(cameras) ? cameras : [];
  if (list.length === 0) {
    return { title: "Camera bitrate", mode: "empty", charts: [] };
  }
  if (list.length <= SMALL_MULTIPLE_THRESHOLD) {
    return {
      title: "Camera bitrate",
      mode: "single",
      charts: [buildLineChart({
        title: "Camera bitrate", unitLabel: "kbps",
        seriesList: list.map((c, i) => ({
          label: safeLabel(c.cameraId), buckets: c.recordedKbps?.buckets ?? [],
          color: colors.categorical[i % colors.categorical.length],
        })),
        colors,
      })],
    };
  }
  const yDomain = sharedYDomainForBuckets(list.map((c) => c.recordedKbps?.buckets ?? []));
  return {
    title: "Camera bitrate",
    mode: "small-multiples",
    charts: list.map((c) => buildLineChart({
      title: safeLabel(c.cameraId), unitLabel: "kbps",
      seriesList: [{ label: safeLabel(c.cameraId), buckets: c.recordedKbps?.buckets ?? [], color: colors.categorical[0] }],
      yDomain, colors, width: 300, height: 140, endLabels: false,
    })),
  };
}

/** One chart per interface, rx and tx as two series with a legend -- the
 *  same rx=slot1/tx=slot2 convention agent/ui/network-client.mjs already
 *  uses for its own rate strip, kept here rather than invented fresh. */
export function buildNetworkSection(interfaces, colors) {
  const list = Array.isArray(interfaces) ? interfaces : [];
  return {
    title: "Network",
    charts: list.map((iface) => buildLineChart({
      title: safeLabel(iface.name), unitLabel: "Mbps",
      seriesList: [
        { label: "rx", buckets: iface.rxMbps?.buckets ?? [], color: colors.categorical[0] },
        { label: "tx", buckets: iface.txMbps?.buckets ?? [], color: colors.categorical[1] },
      ],
      colors,
    })),
  };
}

export function buildRecordingStripsSection(cameras, rangeStartUtc, rangeEndUtc, colors) {
  const list = Array.isArray(cameras) ? cameras : [];
  return {
    title: "Recording",
    charts: list.map((c) => buildStripChart({
      title: `Recording — ${safeLabel(c.cameraId)}`,
      spans: c.recording?.spans ?? [], rangeStartUtc, rangeEndUtc, colors,
    })),
  };
}

export function buildRecorderRunningStrip(recorderRunning, rangeStartUtc, rangeEndUtc, colors) {
  return buildStripChart({
    title: "Recorder running", spans: recorderRunning?.spans ?? [], rangeStartUtc, rangeEndUtc, colors,
  });
}

/** "A note says 'history from HH:MM' when the store holds less than the
 *  range" (spec) -- null when the store already covers the full window
 *  (nothing to caveat), computed from the same two timestamps the JSON body
 *  already carries rather than a second reading of the clock. */
export function historyFromNote(historyJson, range) {
  const atMs = Date.parse(historyJson?.atUtc);
  const fromMs = Date.parse(historyJson?.historyFromUtc);
  const windowMs = RANGE_WINDOW_MS[range] ?? RANGE_WINDOW_MS["24h"];
  if (!Number.isFinite(atMs) || !Number.isFinite(fromMs)) return null;
  if (atMs - fromMs < windowMs - 1000) {
    return `history from ${localTimeUtc(historyJson.historyFromUtc)}`;
  }
  return null;
}

/* ── crosshair + tooltip: DOM-only wiring, not part of the pure builders ── */
//
// Everything above this point is pure (series in, vnode/string out), per the
// spec's own "Code shape" requirement, and that is what harness/
// healthCharts.harness.mjs proves. A hover crosshair needs live pointer
// events and getBoundingClientRect, which only exist once the vnode tree is
// real DOM -- so it lives here, called once per chart AFTER
// agent/ui/system-client.mjs has mounted it with vnodeToDom, and is exempt
// from the "pure function" contract by construction (interaction.md: "ship
// a crosshair+tooltip on line/area... the hit target is bigger than the
// mark" -- the .hc-hit circles above already are, at r=10).
//
// Every value the tooltip shows -- time, median, unit, n -- is read back off
// the SAME data-t/data-v/data-n attributes the pure builder already wrote
// onto each hit circle (interaction.md: "every value a tooltip shows is
// also reachable without it" -- here, in the chart's own table-view twin).

/** Wires one line chart's hover: a vertical crosshair line snapped to the
 *  nearest hc-hit circle's x, and a tooltip showing every series' value at
 *  that x (interaction.md: "one tooltip, every series"). `chartEl` is the
 *  ".hc-chart" div vnodeToDom produced; `unitLabel` is the chart's own unit,
 *  read once rather than re-derived from a hit circle's own text. */
export function wireLineChartHover(doc, chartEl, unitLabel) {
  const svg = chartEl.querySelector ? chartEl.querySelector(".hc-svg") : null;
  if (!svg) return;
  const hits = Array.from(svg.querySelectorAll ? svg.querySelectorAll(".hc-hit") : []);
  if (hits.length === 0) return;

  const crosshair = doc.createElementNS(SVG_NS, "line");
  crosshair.setAttribute("class", "hc-crosshair");
  crosshair.setAttribute("y1", "0");
  crosshair.setAttribute("y2", String(svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.height : 200));
  crosshair.setAttribute("stroke", "currentColor");
  crosshair.setAttribute("stroke-width", "1");
  crosshair.setAttribute("opacity", "0");
  svg.appendChild(crosshair);

  const tooltip = doc.createElement("div");
  tooltip.className = "hc-tooltip";
  tooltip.setAttribute("role", "status");
  tooltip.style.position = "absolute";
  tooltip.style.opacity = "0";
  tooltip.style.pointerEvents = "none";
  chartEl.style.position = chartEl.style.position || "relative";
  chartEl.appendChild(tooltip);

  const points = hits.map((el) => ({
    el,
    x: Number(el.getAttribute("cx")),
    t: el.getAttribute("data-t"),
    v: el.getAttribute("data-v"),
    n: el.getAttribute("data-n"),
    series: el.getAttribute("data-series"),
  })).sort((a, b) => a.x - b.x);

  function nearestAt(viewBoxX) {
    let best = points[0];
    let bestDist = Math.abs(points[0].x - viewBoxX);
    for (const p of points) {
      const dist = Math.abs(p.x - viewBoxX);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    return best;
  }

  function toViewBoxX(clientX) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const width = vb ? vb.width : rect.width;
    if (rect.width === 0) return 0;
    return ((clientX - rect.left) / rect.width) * width;
  }

  function showAt(nearest, clientX, clientY) {
    crosshair.setAttribute("x1", String(nearest.x));
    crosshair.setAttribute("x2", String(nearest.x));
    crosshair.setAttribute("opacity", "1");
    const sameX = points.filter((p) => p.x === nearest.x);
    const lines = sameX.map((p) => {
      const label = p.series ? `${p.series}: ` : "";
      const nSuffix = p.n !== null ? ` (n=${p.n})` : "";
      return `${label}${p.v} ${unitLabel}${nSuffix}`;
    });
    const timeLabel = nearest.t ? localTimeUtc(nearest.t) : "";
    tooltip.replaceChildren
      ? tooltip.replaceChildren()
      : (tooltip.textContent = "");
    const timeEl = doc.createElement("div");
    timeEl.className = "hc-tooltip-time";
    timeEl.textContent = timeLabel;
    tooltip.appendChild(timeEl);
    for (const line of lines) {
      const row = doc.createElement("div");
      row.textContent = line;
      tooltip.appendChild(row);
    }
    const chartRect = chartEl.getBoundingClientRect();
    tooltip.style.left = `${clientX - chartRect.left + 12}px`;
    tooltip.style.top = `${clientY - chartRect.top + 12}px`;
    tooltip.style.opacity = "1";
  }

  function hide() {
    crosshair.setAttribute("opacity", "0");
    tooltip.style.opacity = "0";
  }

  svg.addEventListener("pointermove", (ev) => {
    const nearest = nearestAt(toViewBoxX(ev.clientX));
    showAt(nearest, ev.clientX, ev.clientY);
  });
  svg.addEventListener("pointerleave", hide);
  // Keyboard focus gets the same readout as hover (interaction.md: "same
  // details on keyboard focus as on hover"), landing on the midpoint hit.
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("focus", () => {
    const mid = points[Math.floor(points.length / 2)];
    const rect = svg.getBoundingClientRect();
    showAt(mid, rect.left + rect.width / 2, rect.top);
  });
  svg.addEventListener("blur", hide);
}

/** Wires one strip chart's hover: interaction.md's bar/cell rule ("the mark
 *  IS the hit target... no crosshair") -- each segment gets its own
 *  pointermove/focus tooltip showing its state and time range, read back off
 *  the same data-state/data-from/data-to attributes buildStripChart wrote. */
export function wireStripChartHover(doc, chartEl) {
  const svg = chartEl.querySelector ? chartEl.querySelector(".hc-svg") : null;
  if (!svg) return;
  const segs = Array.from(svg.querySelectorAll ? svg.querySelectorAll(".hc-strip-seg") : []);
  if (segs.length === 0) return;

  const tooltip = doc.createElement("div");
  tooltip.className = "hc-tooltip";
  tooltip.setAttribute("role", "status");
  tooltip.style.position = "absolute";
  tooltip.style.opacity = "0";
  tooltip.style.pointerEvents = "none";
  chartEl.style.position = chartEl.style.position || "relative";
  chartEl.appendChild(tooltip);

  function show(seg, clientX, clientY) {
    const state = seg.getAttribute("data-state");
    const from = seg.getAttribute("data-from");
    const to = seg.getAttribute("data-to");
    tooltip.textContent = `${state}: ${from ? localTimeUtc(from) : "?"}–${to ? localTimeUtc(to) : "?"}`;
    const chartRect = chartEl.getBoundingClientRect();
    tooltip.style.left = `${clientX - chartRect.left + 12}px`;
    tooltip.style.top = `${clientY - chartRect.top + 12}px`;
    tooltip.style.opacity = "1";
  }
  function hide() {
    tooltip.style.opacity = "0";
  }
  for (const seg of segs) {
    seg.setAttribute("tabindex", "0");
    seg.addEventListener("pointermove", (ev) => show(seg, ev.clientX, ev.clientY));
    seg.addEventListener("pointerleave", hide);
    seg.addEventListener("focus", (ev) => {
      const rect = seg.getBoundingClientRect();
      show(seg, rect.left, rect.top);
    });
    seg.addEventListener("blur", hide);
  }
}

/**
 * Every chart the History section shows, from one GET /health/history body.
 * `range` ("24h"|"7d") is the range the client asked for -- needed only to
 * place the two strips (recording, recorderRunning) across the FULL
 * requested window; every line chart's own width already spans the full
 * window because BUCKET_COUNT[range] buckets are always returned in order
 * (contracts/healthHistory.ts's bucketSamples), gaps included.
 */
export function buildHistorySection(historyJson, range, colors) {
  const j = (historyJson && typeof historyJson === "object") ? historyJson : {};
  const rangeEndUtc = typeof j.atUtc === "string" ? j.atUtc : new Date().toISOString();
  const windowMs = RANGE_WINDOW_MS[range] ?? RANGE_WINDOW_MS["24h"];
  const rangeStartUtc = new Date(Date.parse(rangeEndUtc) - windowMs).toISOString();
  return {
    note: historyFromNote(j, range),
    cpu: buildCpuChart(j.cpu, colors),
    temperature: buildTemperatureChart(j.temperature, colors),
    memory: buildMemoryChart(j.memUsedMiB, colors),
    drives: buildDrivesChart(j.drives, colors),
    cameraBitrate: buildCameraBitrateSection(j.cameras, colors),
    network: buildNetworkSection(j.interfaces, colors),
    recording: buildRecordingStripsSection(j.cameras, rangeStartUtc, rangeEndUtc, colors),
    recorderRunning: buildRecorderRunningStrip(j.recorderRunning, rangeStartUtc, rangeEndUtc, colors),
  };
}
