// agent/ui/activity-charts.mjs
//
// Bar charts for the activity page (ACTIVITY-PAGE-SPEC.md, Shape item 3):
// person and vehicle sightings by local hour (24h) or local day (7d), one
// series per camera when the page is showing more than one at once. Pure --
// an array of contracts/activity.ts's ActivityBucket[] in, a vnode tree out,
// the same "series in, SVG string out ... tested in Node" contract
// HEALTH-HISTORY-SPEC.md set and agent/ui/health-charts.mjs already follows.
// That file's vnodeToString/vnodeToDom, safeLabel and validated palette are
// imported and reused here, not duplicated (this page's own house rule --
// "Reuse agent/ui/health-charts.mjs's validated palette ... instead of
// inventing new colours", ACTIVITY-PAGE-SPEC.md's YOUR JOB note).
//
// THE FEARED FAILURE, named the way build rule 19 and this spec's own "Tests
// that matter" section ask for: a hour/day the AI was not watching (or had
// no video for, or predates watch measurement, or predates this NVR's oldest
// kept video) rendered as a bar of height 0 -- indistinguishable from an hour
// that WAS watched and genuinely saw nobody (build rule 5: "a blank is not a
// zero"). Every one of those four statuses (contracts/activity.ts's
// BucketStatus: "not_watching", "no_video", "before_oldest_video",
// "watch_not_measured") draws instead as a FULL-HEIGHT hatched placeholder
// carrying its own word ("not watching", "no video", ...), on its own SVG
// <pattern> (45 degrees, tone-on-tone -- dataviz/references/palette.md's
// texture spec) -- never a shorter bar, never a bare zero, and never
// confused with "counted"/"partly_watched" (real measurements, drawn as
// ordinary solid bars, however small or however tall).
//
// A second failure this file guards by construction: the banned words. The
// spec calls these "person sightings" and "vehicle sightings" -- never
// "people", "customers" or "visitors" (rule 11: report measurements, never a
// verdict on who they were). Nothing in this file ever emits those three
// words; the harness (harness/activityPage.harness.mjs) greps every string
// this module can produce to prove it.

import { vnodeToString, vnodeToDom, safeLabel, localTimeUtc } from "./health-charts.mjs";

const BAR_PAD = { left: 46, right: 10, top: 20, bottom: 34 };
const MAX_BAR_PX = 24; // marks-and-anatomy.md: bars <= 24px thick.
const BAR_GAP_PX = 2; // the surface gap that separates touching marks, not a stroke.
const MIN_BAR_PX = 2;
// The narrowest bar an in-bar hatch label is still drawn on. Measured
// directly (getBoundingClientRect(), which -- unlike getBBox() -- reflects
// an element's own rotate transform): a font-size-8 label's own rendered
// footprint clears its bar's right edge with room to spare at barW=20.33
// (the ordinary single-camera 24h chart's own bar width) but starts
// spilling into the very next bar under it once barW drops into the
// low-to-mid teens -- exactly the case of a 2+-camera grouped chart's
// default width (barW ~9). Below this width the label is dropped rather
// than drawn overlapping a neighbour (which can be a REAL "counted" bar,
// not just another hatched one); the tooltip and the table view already
// carry the same word at every width, so nothing is actually lost.
const MIN_LABEL_BAR_PX = 18;

/** The word (or, for "watch_not_measured" with a hh:mm reason, the fuller
 *  sentence contracts/activity.ts already built) a hatched bucket carries.
 *  Exported so the client and the harness can both point at the one source
 *  of these words, rather than each spelling them out again. */
export const BLANK_STATUS_LABEL = Object.freeze({
  not_watching: "not watching",
  no_video: "no video",
  before_oldest_video: "before this NVR's oldest video",
  watch_not_measured: "watch time not measured",
});

/** The four statuses that must never be drawn as a measured bar -- see the
 *  file header. "counted" and "partly_watched" are real measurements (a
 *  partly_watched bucket still carries a genuine, if partial, count) and are
 *  never in this set. */
export function isBlankStatus(status) {
  return Object.hasOwn(BLANK_STATUS_LABEL, status);
}

/** The exact words this bucket's hatch is labelled with -- watchedReason
 *  when the bucket carried one (buildActivityBucket's own "watch time not
 *  measured before HH:MM"), else the generic word for its status. */
export function blankLabelFor(bucket) {
  if (bucket && bucket.status === "watch_not_measured"
    && typeof bucket.watchedReason === "string" && bucket.watchedReason !== "") {
    return bucket.watchedReason;
  }
  return BLANK_STATUS_LABEL[bucket?.status] ?? String(bucket?.status ?? "unknown");
}

function h(tag, attrs = {}, children = [], text = null) {
  return { tag, attrs, children, text };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const norm = v / magnitude;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * magnitude;
}

/** The axis ceiling: the largest ACTUALLY MEASURED value across every
 *  series' own bucket for this `kind` ("person" or "vehicle") -- a blank
 *  bucket's own count (usually 0, but this file never assumes so) never
 *  enters the scale, so one hatched hour cannot flatten every real bar next
 *  to it. */
function yMaxFromSeries(seriesList, kind) {
  let max = 0;
  for (const s of seriesList) {
    for (const b of s.buckets ?? []) {
      if (!b || isBlankStatus(b.status)) continue;
      const v = b[kind];
      if (typeof v === "number" && v > max) max = v;
    }
  }
  return niceMax(max || 1);
}

/** A short, stable id for a pattern <defs> entry, one per distinct colour a
 *  chart's blank bars use -- never per bucket, so a 24-bucket chart with
 *  several blank hours defines the pattern once and every bar references it. */
function patternIdFor(prefix, color) {
  return `${prefix}-${String(color).replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** One 45-degree hand-drawn "Lines" fill (dataviz/references/palette.md:
 *  "One hand-drawn 'Lines' fill, used at 45 degrees and its 135 degree
 *  mirror only. Inked tone-on-tone"), tinted from the series' own colour so a
 *  4-camera grouped chart's hatched bars still read as "this camera, but
 *  unmeasured" rather than one indistinct grey for everyone. */
function hatchPatternVNode(id, color) {
  return h("pattern", {
    id, patternUnits: "userSpaceOnUse", width: "8", height: "8", patternTransform: "rotate(45)",
  }, [
    h("rect", { width: "8", height: "8", fill: color, opacity: "0.16" }),
    h("line", { x1: "0", y1: "0", x2: "0", y2: "8", stroke: color, "stroke-width": "2", opacity: "0.55" }),
  ]);
}

function xAxisTicks(buckets, colors, plotW, plotH, dateLabel) {
  const n = buckets.length;
  if (n === 0) return [];
  const stride = Math.max(1, Math.ceil(n / 6));
  const nodes = [];
  for (let i = 0; i < n; i += stride) {
    const b = buckets[i];
    if (!b) continue;
    const x = round(BAR_PAD.left + (i + 0.5) * (plotW / n));
    nodes.push(h("text", {
      x, y: round(BAR_PAD.top + plotH + 14), "text-anchor": "middle",
      "font-size": "10", fill: colors.textMuted, class: "act-xtick",
    }, [], dateLabel(b.startUtc)));
  }
  return nodes;
}

function yAxisTicks(domainMax, colors, plotW, plotH, unitLabel) {
  const rawTicks = [0, domainMax / 2, domainMax];
  // De-duplicate by the ROUNDED label each tick will actually draw, not by
  // the raw value -- a domainMax of 1 (an ordinary small chart: the highest
  // bucket in view is a single sighting) makes the midpoint 0.5 round UP to
  // "1", the same label the top tick already carries, and drawing both
  // gridlines then reads as two different heights for the same number. Skip
  // whichever duplicate loses the tie, so every gridline on screen carries
  // a distinct label.
  const seenLabels = new Set();
  const ticks = [];
  for (const t of rawTicks) {
    const label = String(Math.round(t));
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    ticks.push(t);
  }
  const nodes = [];
  for (const t of ticks) {
    const y = round(BAR_PAD.top + plotH - (domainMax > 0 ? (t / domainMax) * plotH : 0));
    nodes.push(h("line", {
      x1: BAR_PAD.left, x2: BAR_PAD.left + plotW, y1: y, y2: y,
      stroke: colors.grid, "stroke-width": "1", class: "act-grid",
    }));
    nodes.push(h("text", {
      x: BAR_PAD.left - 6, y: y + 3, "text-anchor": "end", fill: colors.textMuted, "font-size": "10",
    }, [], String(Math.round(t))));
  }
  // Exactly one of these per chart -- this file's own proof (mirroring
  // health-charts.mjs's yAxisVNodes) that a chart never grows a second,
  // competing y-scale (ACTIVITY-PAGE-SPEC.md: "never two scales on one chart").
  nodes.push(h("text", {
    x: 2, y: 11, class: "act-yaxis", fill: colors.textMuted, "font-size": "10",
  }, [], unitLabel));
  return nodes;
}

function legendVNode(seriesList, colors) {
  if (seriesList.length < 2) return null; // a single series names itself in the title.
  return h("div", { class: "act-legend" }, seriesList.map((s) => h("span", { class: "act-legend-item" }, [
    h("span", { class: "act-swatch", style: `background:${s.color}` }),
    h("span", {}, [], safeLabel(s.label)),
  ])));
}

/** "watched 42 of 60 min" (ACTIVITY-PAGE-SPEC.md) -- for the table view and
 *  the tooltip. `bucketMinutes` is the bucket's own real length (60 for an
 *  hour; up to ~1500 for a 25-hour fall-back day's roll-up), never a fixed
 *  60 assumed for every bucket -- rollUpDayBucket's own day-shaped buckets
 *  can be far longer than an hour. */
function watchedNote(bucket, bucketMinutes) {
  if (bucket.watchedMin === null) return null;
  if (bucket.watchedMin >= bucketMinutes) return null;
  return `watched ${Math.round(bucket.watchedMin)} of ${Math.round(bucketMinutes)} min`;
}

function bucketMinutesOf(bucket) {
  const ms = Date.parse(bucket.endUtc) - Date.parse(bucket.startUtc);
  return Math.round(ms / 60_000);
}

function tableVNode(seriesList, kind, unitLabel, dateLabel) {
  const n = Math.max(0, ...seriesList.map((s) => (s.buckets ?? []).length));
  // The hidden (known-object) count and the footage-coverage minutes get
  // their own column PER SERIES, always -- never dropped once a second
  // camera joins the chart (the single-series case just has one of each,
  // so the header/row shape below still reads "Time, sightings, hidden,
  // coverage" exactly as before). A tooltip is not an acceptable substitute
  // for these: the dataviz skill's own rule is that every value reachable
  // by hover must also be reachable without it, for keyboard and
  // screen-reader users and for anyone using this table instead of the
  // chart.
  const head = h("tr", {}, [
    h("th", {}, [], "Time"),
    ...seriesList.map((s) => h("th", {}, [], seriesList.length > 1 ? `${safeLabel(s.label)} (${unitLabel})` : unitLabel)),
    ...seriesList.map((s) => h("th", {}, [], seriesList.length > 1 ? `${safeLabel(s.label)} (hidden)` : "hidden")),
    ...seriesList.map((s) => h("th", {}, [], seriesList.length > 1 ? `${safeLabel(s.label)} (coverage)` : "coverage")),
  ]);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const first = seriesList[0]?.buckets?.[i];
    const cells = [h("td", {}, [], first ? dateLabel(first.startUtc) : "")];
    for (const s of seriesList) {
      const b = s.buckets?.[i];
      if (!b) { cells.push(h("td", {}, [], "")); continue; }
      if (isBlankStatus(b.status)) {
        cells.push(h("td", { class: "act-cell-blank" }, [], blankLabelFor(b)));
      } else {
        const note = watchedNote(b, bucketMinutesOf(b));
        cells.push(h("td", {}, [], note ? `${b[kind]} ${unitLabel} (${note})` : `${b[kind]} ${unitLabel}`));
      }
    }
    for (const s of seriesList) {
      const b = s.buckets?.[i];
      cells.push(h("td", {}, [], b ? (isBlankStatus(b.status) ? "" : String(b.hidden ?? 0)) : ""));
    }
    for (const s of seriesList) {
      const b = s.buckets?.[i];
      cells.push(h("td", {}, [], b ? `${Math.round(b.footageMin ?? 0)} min video` : ""));
    }
    rows.push(h("tr", {}, cells));
  }
  return h("details", { class: "act-table-toggle" }, [
    h("summary", {}, [], "Table view"),
    h("table", { class: "act-table" }, [h("thead", {}, [head]), h("tbody", {}, rows)]),
  ]);
}

/**
 * One bar chart: grouped bars (one group per bucket, one bar per series in
 * the group -- 1 to 4 series in practice, since a 5th camera goes to small
 * multiples instead, see buildSightingsSection), one y-axis, a hatched
 * full-height placeholder (never a shorter bar) for any bucket whose status
 * is a blank one (isBlankStatus), a legend when there are 2+ series, and a
 * table-view twin carrying the same numbers and the same words.
 *
 * `seriesList`: [{ label, color, buckets: ActivityBucket[] }], all the same
 * length, in time order. `kind`: "person" or "vehicle" -- which field of each
 * bucket this chart draws; the OTHER kind is always a separate chart with
 * its own y-scale (ACTIVITY-PAGE-SPEC.md: "never two scales on one chart"),
 * never plotted here too.
 */
export function buildBarChart({ title, unitLabel, kind, seriesList, colors, width = 640, height = 220, dateLabel = localTimeUtc }) {
  const list = Array.isArray(seriesList) ? seriesList : [];
  const n = Math.max(0, ...list.map((s) => (s.buckets ?? []).length));
  const domainMax = yMaxFromSeries(list, kind);
  const plotW = width - BAR_PAD.left - BAR_PAD.right;
  const plotH = height - BAR_PAD.top - BAR_PAD.bottom;
  const groupW = n > 0 ? plotW / n : plotW;
  const seriesCount = Math.max(1, list.length);
  const barW = Math.max(MIN_BAR_PX, Math.min(MAX_BAR_PX, (groupW - BAR_GAP_PX * (seriesCount + 1)) / seriesCount));

  const defs = [];
  const patternsSeen = new Set();
  const bars = [];

  for (let i = 0; i < n; i++) {
    const groupX = BAR_PAD.left + i * groupW + Math.max(0, (groupW - (barW * seriesCount + BAR_GAP_PX * (seriesCount + 1))) / 2);
    for (let j = 0; j < list.length; j++) {
      const series = list[j];
      const bucket = (series.buckets ?? [])[i];
      if (!bucket) continue;
      const x = round(groupX + BAR_GAP_PX + j * (barW + BAR_GAP_PX));
      const blank = isBlankStatus(bucket.status);
      const common = {
        "data-status": bucket.status, "data-t": bucket.startUtc, "data-end": bucket.endUtc,
        "data-camera": safeLabel(series.label), "data-kind": kind,
        // The RAW camera id, for the Review deep link -- distinct from
        // data-camera above (a display name, already run through safeLabel,
        // which redacts anything URL-shaped and so must never be trusted as
        // an id to build a link from). Falls back to the label only for a
        // series that never carried a real cameraId (a combined/no-camera-
        // filter series has no single id to link to; buildSightingsSection
        // never builds one of those, so this path is only reached by a
        // caller that constructs its own seriesList directly).
        "data-camera-id": typeof series.cameraId === "string" && series.cameraId !== "" ? series.cameraId : "",
        "data-hidden": String(bucket.hidden ?? 0), "data-footage": String(bucket.footageMin ?? 0),
        "data-watched": bucket.watchedMin === null ? "" : String(bucket.watchedMin),
        "data-bucket-min": String(bucketMinutesOf(bucket)),
      };
      if (blank) {
        const label = blankLabelFor(bucket);
        const patId = patternIdFor("act-hatch", series.color);
        if (!patternsSeen.has(patId)) {
          patternsSeen.add(patId);
          defs.push(hatchPatternVNode(patId, series.color));
        }
        bars.push(h("rect", {
          x, y: round(BAR_PAD.top), width: round(barW), height: round(plotH),
          fill: `url(#${patId})`, class: "act-bar act-bar-blank", rx: "3",
          ...common, "data-label": label,
        }));
        // Below MIN_LABEL_BAR_PX, even a 90-degree-rotated label's own
        // rendered footprint (its font size becomes its horizontal width
        // once rotated) is wider than the bar itself, and spills into a
        // neighbouring bar -- confirmed by measuring the actual rendered
        // SVG's getBBox() at the default 24h/2-camera width, where several
        // rotated labels ran 2-9px into the bar next door, including a real
        // "counted" bar (not just another hatched one). Rather than render
        // truncated or overlapping text, this bar's word is dropped from
        // the chart and left to the two places that already carry it in
        // full regardless of bar width: the tooltip (wireBarChartHover's
        // own data-label read) and the table view (tableVNode's own
        // per-bucket "hidden"/blank-word cell) -- so no information is lost,
        // only an in-bar label that could not fit without lying about its
        // neighbour's own bar.
        if (barW >= MIN_LABEL_BAR_PX) {
          bars.push(h("text", {
            x: round(x + barW / 2), y: round(BAR_PAD.top + 12), "text-anchor": "middle",
            "font-size": "8", fill: colors.textMuted, class: "act-bar-label",
          }, [], label));
        }
        continue;
      }
      const value = typeof bucket[kind] === "number" ? bucket[kind] : 0;
      const barHeightPx = domainMax > 0 ? (value / domainMax) * plotH : 0;
      const y = BAR_PAD.top + plotH - barHeightPx;
      bars.push(h("rect", {
        x, y: round(y), width: round(barW), height: round(Math.max(0, barHeightPx)),
        fill: series.color, class: "act-bar", rx: "2",
        ...common, "data-value": String(value),
      }));
    }
  }

  const axisNodes = [...yAxisTicks(domainMax, colors, plotW, plotH, unitLabel), ...xAxisTicks(list[0]?.buckets ?? [], colors, plotW, plotH, dateLabel)];
  const seriesDescription = list.map((s) => safeLabel(s.label)).join(", ") || "no data";
  const svg = h("svg", {
    viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "act-svg", role: "img",
    "aria-label": `${title}, in ${unitLabel}: ${seriesDescription}`,
  }, [
    ...(defs.length > 0 ? [h("defs", {}, defs)] : []),
    h("g", { class: "act-axis" }, axisNodes),
    ...bars,
  ]);
  const legend = legendVNode(list, colors);
  const table = tableVNode(list, kind, unitLabel, dateLabel);
  return {
    title, unitLabel, kind,
    vnode: h("div", { class: "act-chart" }, [
      h("div", { class: "act-title" }, [], title),
      svg,
      ...(legend ? [legend] : []),
      table,
    ]),
  };
}

const SMALL_MULTIPLE_THRESHOLD = 4;

/**
 * Every chart for one sighting kind ("person" or "vehicle"), from the
 * per-camera bucket arrays already in scope (one camera, when the page's own
 * camera filter picked one; every configured camera otherwise). Mirrors
 * agent/ui/health-charts.mjs's buildCameraBitrateSection: 1-4 cameras share
 * one grouped chart with a legend; a 5th sends every camera to its own small
 * chart on a shared y-scale instead of one unreadable 24-bar-wide group.
 *
 * `perCamera`: [{ cameraId, name, buckets: ActivityBucket[] }].
 */
export function buildSightingsSection({ kind, unitLabel, perCamera, colors, dateLabel = localTimeUtc, title }) {
  const list = Array.isArray(perCamera) ? perCamera : [];
  if (list.length === 0) {
    return { title, kind, mode: "empty", charts: [] };
  }
  if (list.length <= SMALL_MULTIPLE_THRESHOLD) {
    return {
      title, kind, mode: "single",
      charts: [buildBarChart({
        title, unitLabel, kind, colors, dateLabel,
        seriesList: list.map((c, i) => ({
          label: c.name ?? c.cameraId, cameraId: c.cameraId,
          color: colors.categorical[i % colors.categorical.length], buckets: c.buckets,
        })),
      })],
    };
  }
  return {
    title, kind, mode: "small-multiples",
    charts: list.map((c) => buildBarChart({
      title: safeLabel(c.name ?? c.cameraId), unitLabel, kind, colors, dateLabel, width: 320, height: 160,
      seriesList: [{ label: c.name ?? c.cameraId, cameraId: c.cameraId, color: colors.categorical[0], buckets: c.buckets }],
    })),
  };
}

/**
 * Wires one bar chart's hover/focus: interaction.md's "bar/cell" rule -- the
 * mark IS the hit target, no crosshair. Every value the tooltip shows
 * (time, count or blank word, unit, watched minutes, hidden count) is read
 * back off the same data-* attributes buildBarChart already wrote onto the
 * bar, and every one of those is also in the table view -- a tooltip here
 * never gates a value the table does not already carry.
 */
export function wireBarChartHover(doc, chartEl) {
  const svg = chartEl.querySelector ? chartEl.querySelector(".act-svg") : null;
  if (!svg) return;
  const marks = Array.from(svg.querySelectorAll ? svg.querySelectorAll(".act-bar") : []);
  if (marks.length === 0) return;

  const tooltip = doc.createElement("div");
  tooltip.className = "act-tooltip";
  tooltip.setAttribute("role", "status");
  tooltip.style.position = "absolute";
  tooltip.style.opacity = "0";
  tooltip.style.pointerEvents = "none";
  chartEl.style.position = chartEl.style.position || "relative";
  chartEl.appendChild(tooltip);

  function lineFor(mark) {
    const camera = mark.getAttribute("data-camera");
    const t = mark.getAttribute("data-t");
    const timeLabel = t ? localTimeUtc(t) : "";
    const label = mark.getAttribute("data-label");
    const kind = mark.getAttribute("data-kind");
    const hidden = mark.getAttribute("data-hidden");
    const watched = mark.getAttribute("data-watched");
    const bucketMin = mark.getAttribute("data-bucket-min");
    const parts = [camera ? `${camera} — ${timeLabel}` : timeLabel];
    if (label !== null && label !== "") {
      parts.push(label);
    } else {
      const value = mark.getAttribute("data-value");
      parts.push(`${value} ${kind} sightings`);
      if (watched !== null && watched !== "" && bucketMin !== null && Number(watched) < Number(bucketMin)) {
        parts.push(`watched ${watched} of ${bucketMin} min`);
      }
    }
    if (hidden && hidden !== "0") parts.push(`${hidden} hidden (known object)`);
    return parts;
  }

  function show(mark, clientX, clientY) {
    mark.classList && mark.classList.add ? mark.classList.add("act-bar-hover") : null;
    tooltip.replaceChildren ? tooltip.replaceChildren() : (tooltip.textContent = "");
    for (const line of lineFor(mark)) {
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
    tooltip.style.opacity = "0";
  }
  for (const mark of marks) {
    mark.setAttribute("tabindex", "0");
    mark.addEventListener("pointermove", (ev) => show(mark, ev.clientX, ev.clientY));
    mark.addEventListener("pointerleave", hide);
    mark.addEventListener("focus", () => {
      const rect = mark.getBoundingClientRect ? mark.getBoundingClientRect() : { left: 0, top: 0 };
      show(mark, rect.left, rect.top);
    });
    mark.addEventListener("blur", hide);
  }
}

export { vnodeToString, vnodeToDom, safeLabel, localTimeUtc };
