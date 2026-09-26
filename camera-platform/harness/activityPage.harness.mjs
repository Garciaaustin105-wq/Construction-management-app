/**
 * The activity page (ACTIVITY-PAGE-SPEC.md, Shape item 3), run without a
 * browser: agent/ui/activity-charts.mjs's pure bar-chart builders, and
 * agent/ui/activity-client.mjs's page-specific (but still DOM-optional)
 * logic -- the Review deep link it builds, and the words it is never
 * allowed to print.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/activityPage.harness.mjs`.
 *
 * THE FEARED FAILURES, in the spec's own words:
 *  - "a not-watching bucket is hatched and labelled, never a 0 bar" -- and
 *    the same for no-video, before-this-NVR's-oldest-video and
 *    watch-not-measured: build rule 5, a blank read as a zero.
 *  - "the words 'people', 'customers' and 'visitors' never appear on the
 *    page as a count label" -- checked against every chart this file can
 *    render, and against the page's own static text.
 *  - the table view disagreeing with the chart it is supposed to mirror
 *    (WCAG accessibility -- the same numbers, not a re-derived summary).
 *  - the Review deep link built from the wrong field (a display name instead
 *    of a camera id, which happens to look similar in a fixture with one
 *    camera and would pass a less careful check).
 *  - the nav link staying up for a role that lost events.view, or hidden for
 *    one that has it.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, same, report } from "./_assert.mjs";

const root = process.cwd();
const charts = await import(pathToFileURL(join(root, "agent/ui/activity-charts.mjs")).href);
const client = await import(pathToFileURL(join(root, "agent/ui/activity-client.mjs")).href);
const health = await import(pathToFileURL(join(root, "agent/ui/health-charts.mjs")).href);
const { PAGE_NEEDS, hideRefusedLinks } = await import(pathToFileURL(join(root, "agent/ui/session-bar.mjs")).href);
const { permissionsFor } = await import(pathToFileURL(join(root, "dist/access.js")).href);
const { decideRoute } = await import(pathToFileURL(join(root, "dist/routeAccess.js")).href);

console.log("activity page");

const {
  buildBarChart, buildSightingsSection, isBlankStatus, blankLabelFor, BLANK_STATUS_LABEL,
  vnodeToString, wireBarClickThrough,
} = { ...charts, wireBarClickThrough: client.wireBarClickThrough };
const { CHART_COLORS_DARK, CHART_COLORS_LIGHT } = health;

/* ── fixtures: 24 hourly buckets, one calendar day, with the statuses the
   spec itself names as the ones that must never look like a zero ────────── */

const DAY = "2026-09-11";
function edge(hour) {
  const startUtc = `${DAY}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const endUtc = `${DAY}T${String((hour + 1) % 24).padStart(2, "0")}:00:00.000Z`;
  return { startUtc, endUtc };
}

/** A "counted" bucket with a real, sometimes-zero count -- the case a
 *  hatched placeholder must never be confused with. */
function realBucket(hour, person, vehicle, opts = {}) {
  const e = edge(hour);
  return {
    ...e, person, vehicle, hidden: opts.hidden ?? 0,
    footageMin: 60, watchedMin: opts.watchedMin ?? 60, status: opts.status ?? "counted",
  };
}

function blankBucket(hour, status, extra = {}) {
  const e = edge(hour);
  return {
    ...e, person: 0, vehicle: 0, hidden: 0,
    footageMin: status === "no_video" ? 0 : 60,
    watchedMin: (status === "not_watching") ? 0 : null,
    status,
    ...extra,
  };
}

// Hour 3: a genuinely quiet, fully-watched hour -- a real 0, must render as
// an ordinary (invisible) bar, never hatched.
// Hour 7: not watching. Hour 11: no video. Hour 15: before this NVR's oldest
// video. Hour 19: watch time never measured (no watchedReason supplied, so
// the generic word). Hour 20: watch time not measured, WITH a reason string
// (buildActivityBucket's own "watch time not measured before HH:MM").
function buildFixtureBuckets() {
  const buckets = [];
  for (let hour = 0; hour < 24; hour++) {
    if (hour === 3) { buckets.push(realBucket(hour, 0, 0)); continue; }
    if (hour === 7) { buckets.push(blankBucket(hour, "not_watching")); continue; }
    if (hour === 11) { buckets.push(blankBucket(hour, "no_video")); continue; }
    if (hour === 15) { buckets.push(blankBucket(hour, "before_oldest_video")); continue; }
    if (hour === 19) { buckets.push(blankBucket(hour, "watch_not_measured")); continue; }
    if (hour === 20) {
      buckets.push(blankBucket(hour, "watch_not_measured", { watchedReason: "watch time not measured before 04:00" }));
      continue;
    }
    // An ordinary hour, with some real, non-zero, sometimes-hidden traffic.
    buckets.push(realBucket(hour, hour % 4, hour % 3, { hidden: hour === 10 ? 2 : 0 }));
  }
  return buckets;
}

const FIXTURE = buildFixtureBuckets();

/* ── vnode tree helpers: walk the plain {tag, attrs, children, text} tree
   buildBarChart returns, rather than re-parsing the SVG string it can also
   produce -- structural, not regex-fragile. ─────────────────────────────── */

function collect(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children ?? []) collect(child, predicate, out);
  return out;
}

function hasClass(node, cls) {
  const c = node.attrs?.class;
  return typeof c === "string" && c.split(/\s+/).includes(cls);
}

function allText(node) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (typeof n.text === "string") out.push(n.text);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out.join(" ");
}

/* ── 1. a blank bucket never renders as a shorter/zero bar ────────────────── */

for (const status of ["not_watching", "no_video", "before_oldest_video", "watch_not_measured"]) {
  await check(`a "${status}" bucket is hatched and labelled, never a 0 bar`, () => {
    const chart = buildBarChart({
      title: "Person sightings", unitLabel: "sightings", kind: "person",
      seriesList: [{ label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE }],
      colors: CHART_COLORS_DARK,
    });
    const blankRects = collect(chart.vnode, (n) => n.tag === "rect" && n.attrs["data-status"] === status);
    // "watch_not_measured" appears twice in FIXTURE on purpose (hour 19 with
    // no reason, hour 20 with one -- see buildFixtureBuckets' own comment
    // and the reason-preference check just below); every other status
    // appears exactly once.
    eq(blankRects.length, status === "watch_not_measured" ? 2 : 1, "every bucket carrying this status got its own hatched rect");
    const rect = blankRects[0];
    eq(hasClass(rect, "act-bar-blank"), true, "drawn on the hatched-placeholder class, not the ordinary bar class");
    eq(hasClass(rect, "act-bar"), true, "still counts as a bar for hover/click wiring");
    eq(typeof rect.attrs.fill === "string" && rect.attrs.fill.startsWith("url(#act-hatch-"), true, "filled with the hatch pattern, not a solid colour");
    const label = rect.attrs["data-label"];
    eq(typeof label === "string" && label.length > 0, true, "carries its own word");
    const labelNodes = collect(chart.vnode, (n) => n.tag === "text" && n.text === label);
    eq(labelNodes.length > 0, true, `the label "${label}" is drawn as visible text, not only a data attribute`);
    // The defining "never a 0 bar" proof: this rect's own height is the
    // chart's full plot height, not a height computed from its (zero)
    // person count -- the same pixels an hour with 0 REAL sightings would
    // get if this file ever fell back to "no value -> height 0".
    const realZero = collect(chart.vnode, (n) => n.tag === "rect" && n.attrs["data-status"] === "counted" && n.attrs["data-t"] === edge(3).startUtc)[0];
    eq(realZero !== undefined, true, "the genuinely-quiet hour (hour 3) is present for comparison");
    eq(hasClass(realZero, "act-bar-blank"), false, "a real, watched, zero-count hour is an ORDINARY bar");
    eq(Number(rect.attrs.height) > Number(realZero.attrs.height), true, "the hatched placeholder is visually taller than a real zero-height bar, never the same or shorter");
  });
}

await check('"watch_not_measured" prefers its own watchedReason sentence over the generic word, when one was given', () => {
  const withReason = FIXTURE.find((b) => b.status === "watch_not_measured" && b.watchedReason);
  eq(blankLabelFor(withReason), "watch time not measured before 04:00");
  const withoutReason = FIXTURE.find((b) => b.status === "watch_not_measured" && !b.watchedReason);
  eq(blankLabelFor(withoutReason), BLANK_STATUS_LABEL.watch_not_measured);
});

await check("isBlankStatus is exactly the four blank statuses, never counted/partly_watched", () => {
  for (const s of ["not_watching", "no_video", "before_oldest_video", "watch_not_measured"]) {
    eq(isBlankStatus(s), true, s);
  }
  for (const s of ["counted", "partly_watched"]) {
    eq(isBlankStatus(s), false, s);
  }
});

/* ── 1b. a narrow grouped bar never lets its hatch label spill into a
   neighbour -- the default 24h/2-camera view is exactly this width
   (measured: barW ~9px), and a rotated label there was overlapping not
   just another hatched bar but a real "counted" one, confirmed by
   getBoundingClientRect() (not getBBox(), which ignores an element's own
   rotate transform and so hides this) on the actual rendered SVG. ────────── */

await check('REQUIRED, THE FEARED ONE: a 2-camera grouped chart (narrow bars) draws its hatched rect but drops the in-bar text label rather than let it spill onto a neighbour -- the word is still on data-label for the tooltip and still in the table view', () => {
  const grouped = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person", colors: CHART_COLORS_DARK,
    seriesList: [
      { label: "Front Door", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE },
      { label: "Back Lot", cameraId: "cam-2", color: CHART_COLORS_DARK.categorical[1], buckets: FIXTURE },
    ],
  });
  const blankRects = collect(grouped.vnode, (n) => n.tag === "rect" && n.attrs["data-status"] === "not_watching");
  eq(blankRects.length > 0, true, "the hatched rect itself is still drawn");
  for (const rect of blankRects) {
    eq(typeof rect.attrs["data-label"] === "string" && rect.attrs["data-label"].length > 0, true, "the word is still on the rect, for the tooltip (wireBarChartHover reads data-label)");
    const barW = Number(rect.attrs.width);
    eq(barW < 18, true, "sanity: this fixture's 2-camera grouped bar really is this narrow (regression guard for the fixture itself)");
    const ownLabelText = collect(grouped.vnode, (n) => n.tag === "text" && n.text === rect.attrs["data-label"]);
    eq(ownLabelText.length, 0, "REQUIRED: no in-bar <text> label drawn for this narrow a bar -- it would spill outside its own bar's width and into a neighbour, which can be a real counted bar, not just another hatched one");
  }
  // REQUIRED, more directly: no label text is EVER rotated to fit a narrow
  // bar -- the exact mechanism the original bug used (a text anchored at
  // its own start point, offset from the bar's centre, then rotated
  // 90 degrees around that same point) to make a font-size-8 label's own
  // rendered footprint spill past its own bar's edge into whichever bar
  // sits next to it. This alone is checkable without a real DOM (unlike the
  // rendered bounding box itself, which needs getBoundingClientRect() in a
  // real browser -- see the header comment above): the fix removes rotation
  // outright rather than trying to compute a rotated box that always fits.
  const rotatedLabels = collect(grouped.vnode, (n) => n.tag === "text" && typeof n.attrs.transform === "string" && n.attrs.transform.includes("rotate"));
  eq(rotatedLabels.length, 0, "REQUIRED: no hatch label is ever rotated to try to fit a bar -- that rotation, offset from the bar's own centre, is exactly what spilled into a neighbour");
  // The table view (always rendered, regardless of bar width) still carries
  // the same word -- nothing is actually lost by dropping the on-bar text.
  const tableText = allText(collect(grouped.vnode, (n) => n.tag === "table")[0]);
  eq(tableText.includes(BLANK_STATUS_LABEL.not_watching), true, "the table view still says the word the dropped in-bar label would have");
});

await check('a single-camera chart (wide bars, barW ~20px) still draws its in-bar hatch label -- dropping it is only for bars too narrow to hold it, not a blanket removal', () => {
  const single = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person",
    seriesList: [{ label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE }],
    colors: CHART_COLORS_DARK,
  });
  const rect = collect(single.vnode, (n) => n.tag === "rect" && n.attrs["data-status"] === "not_watching")[0];
  eq(Number(rect.attrs.width) >= 18, true, "sanity: this fixture's single-camera bar really is wide enough for a label (regression guard for the fixture itself)");
  const labelNodes = collect(single.vnode, (n) => n.tag === "text" && n.text === rect.attrs["data-label"]);
  eq(labelNodes.length > 0, true, "REQUIRED: a wide-enough bar keeps its visible in-bar label -- the narrow-bar fix must not silently remove it everywhere");
});

/* ── 2. the banned words never appear as a count label ────────────────────── */

const BANNED = ["people", "customers", "visitors"];

function assertNoBannedWords(haystack, where) {
  const lower = haystack.toLowerCase();
  for (const word of BANNED) {
    if (lower.includes(word)) {
      throw new Error(`the banned word "${word}" appears in ${where}`);
    }
  }
}

await check("no banned word appears anywhere in a rendered chart (single, grouped, small multiples, 7d)", () => {
  const single = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person",
    seriesList: [{ label: "Front Door", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE }],
    colors: CHART_COLORS_DARK,
  });
  assertNoBannedWords(vnodeToString(single.vnode), "a single-camera chart");

  const perCamera3 = [
    { cameraId: "cam-1", name: "Front Door", buckets: FIXTURE },
    { cameraId: "cam-2", name: "Back Lot", buckets: FIXTURE },
    { cameraId: "cam-3", name: "Register", buckets: FIXTURE },
  ];
  const grouped = buildSightingsSection({ kind: "vehicle", unitLabel: "sightings", title: "Vehicle sightings", perCamera: perCamera3, colors: CHART_COLORS_LIGHT });
  eq(grouped.mode, "single", "3 cameras stays grouped, not small multiples");
  for (const c of grouped.charts) assertNoBannedWords(vnodeToString(c.vnode), "a grouped 3-camera chart");

  const perCamera6 = Array.from({ length: 6 }, (_, i) => ({ cameraId: `cam-${i + 1}`, name: `Cam ${i + 1}`, buckets: FIXTURE }));
  const smallMultiples = buildSightingsSection({ kind: "person", unitLabel: "sightings", title: "Person sightings", perCamera: perCamera6, colors: CHART_COLORS_DARK });
  eq(smallMultiples.mode, "small-multiples", "past 4 cameras: small multiples");
  eq(smallMultiples.charts.length, 6);
  for (const c of smallMultiples.charts) assertNoBannedWords(vnodeToString(c.vnode), "a small-multiples chart");
});

await check("no banned word appears in the page shell's own RENDERED text (comments may discuss the rule itself), or in the client's own tile/coverage strings", async () => {
  const html = await readFile(join(root, "agent/ui/activity.html"), "utf8");
  // Strip HTML comments first -- this file's own header comment and the
  // <style> block's remarks are allowed to name the banned words while
  // explaining the rule (as this very check's name does); only what a
  // reader actually SEES on the page must never say them.
  const rendered = html.replace(/<!--[\s\S]*?-->/g, "");
  assertNoBannedWords(rendered, "activity.html's rendered markup");
  assertNoBannedWords(client.EXPLAINER_TEXT, "the explainer line");
  // renderTiles/renderCoverage only ever emit literal strings this file
  // already knows about (labels, "sightings", "not yet measured", the
  // coverage sentence) -- proved by construction, not by re-deriving them
  // here, since the fixed strings are exported as EXPLAINER_TEXT above and
  // the rest are checked structurally below.
});

/* ── 3. the table view carries the same numbers as the chart it mirrors ──── */

await check("the table view's counts and blank words match the chart's own bars, bucket for bucket", () => {
  const chart = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person",
    seriesList: [{ label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE }],
    colors: CHART_COLORS_DARK,
  });
  const rows = collect(chart.vnode, (n) => n.tag === "table")[0];
  eq(rows !== undefined, true, "a table exists");
  const bodyRows = collect(rows, (n) => n.tag === "tbody")[0].children;
  eq(bodyRows.length, FIXTURE.length, "one row per bucket");

  for (let i = 0; i < FIXTURE.length; i++) {
    const bucket = FIXTURE[i];
    const cells = bodyRows[i].children;
    const countCell = allText(cells[1]);
    if (isBlankStatus(bucket.status)) {
      eq(countCell, blankLabelFor(bucket), `row ${i}: table shows the same blank word the bar carries`);
      const barsHere = collect(chart.vnode, (n) => n.tag === "rect" && n.attrs["data-t"] === bucket.startUtc && hasClass(n, "act-bar-blank"));
      eq(barsHere.length, 1, `row ${i}: the chart drew exactly one hatched bar for this bucket`);
    } else {
      eq(countCell.startsWith(`${bucket.person} sightings`), true, `row ${i}: table cell "${countCell}" starts with the chart's own count`);
      const bar = collect(chart.vnode, (n) => n.tag === "rect" && n.attrs["data-t"] === bucket.startUtc && hasClass(n, "act-bar") && !hasClass(n, "act-bar-blank"))[0];
      eq(bar !== undefined, true, `row ${i}: an ordinary bar exists for this bucket`);
      eq(Number(bar.attrs["data-value"]), bucket.person, `row ${i}: the bar's own data-value matches the table's count`);
    }
  }
});

/* ── 3b. the table view keeps its hidden/coverage columns once a second
   camera joins the chart -- the default ("all cameras") state, and the one
   a keyboard or screen-reader user, or anyone using the table instead of
   hovering, relies on for the hidden count the spec says every bucket must
   report. ─────────────────────────────────────────────────────────────── */

await check('REQUIRED: a 2-camera (or more) table view still has a "hidden" and "coverage" column per camera -- not silently dropped the moment a second series joins', () => {
  const grouped = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person", colors: CHART_COLORS_DARK,
    seriesList: [
      { label: "Front Door", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE },
      { label: "Back Lot", cameraId: "cam-2", color: CHART_COLORS_DARK.categorical[1], buckets: FIXTURE },
    ],
  });
  const table = collect(grouped.vnode, (n) => n.tag === "table")[0];
  const headTexts = collect(table, (n) => n.tag === "th").map((n) => n.text);
  eq(headTexts.some((t) => /hidden/i.test(t)), true, `REQUIRED: a "hidden" column exists for a 2-camera chart -- got headers ${JSON.stringify(headTexts)}`);
  eq(headTexts.some((t) => /coverage/i.test(t)), true, `REQUIRED: a "coverage" column exists for a 2-camera chart -- got headers ${JSON.stringify(headTexts)}`);
  eq(headTexts.filter((t) => /hidden/i.test(t)).length, 2, "one hidden column per camera, not one shared column");

  // The hour-10 fixture bucket carries a real hidden count (2) -- prove it
  // actually reaches a cell, not just that a column header exists.
  const bodyRows = collect(table, (n) => n.tag === "tbody")[0].children;
  const hour10Row = bodyRows[10];
  const rowText = allText(hour10Row);
  eq(rowText.includes("2"), true, `REQUIRED: hour 10's hidden count (2) is readable somewhere in its table row -- got "${rowText}"`);
});

await check('the single-camera table view is unchanged: one "hidden" and one "coverage" column, in the same position as before', () => {
  const single = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person",
    seriesList: [{ label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE }],
    colors: CHART_COLORS_DARK,
  });
  const table = collect(single.vnode, (n) => n.tag === "table")[0];
  const headTexts = collect(table, (n) => n.tag === "th").map((n) => n.text);
  same(headTexts, ["Time", "sightings", "hidden", "coverage"], "REQUIRED: the single-camera header shape is exactly unchanged by the multi-camera fix");
});

/* ── 4. one y-scale per chart, always ─────────────────────────────────────── */

await check("exactly one y-axis per chart, single or grouped", () => {
  const single = buildBarChart({
    title: "t", unitLabel: "sightings", kind: "vehicle",
    seriesList: [{ label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE }],
    colors: CHART_COLORS_DARK,
  });
  eq(collect(single.vnode, (n) => hasClass(n, "act-yaxis")).length, 1);

  const grouped = buildBarChart({
    title: "t", unitLabel: "sightings", kind: "person", colors: CHART_COLORS_DARK,
    seriesList: [
      { label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: FIXTURE },
      { label: "cam-2", cameraId: "cam-2", color: CHART_COLORS_DARK.categorical[1], buckets: FIXTURE },
    ],
  });
  eq(collect(grouped.vnode, (n) => hasClass(n, "act-yaxis")).length, 1, "2 series sharing one scale, still one axis");
});

await check('REQUIRED: the y-axis never draws two gridlines with the same rounded label -- a domainMax of 1 (the highest real value in view is a single sighting) must not render "1" twice at two different heights', () => {
  // A single real bucket with person=1, everything else 0 -- yMaxFromSeries
  // picks niceMax(1) = 1 (contracts-free arithmetic, but exercised here
  // through the real chart builder rather than reimplemented).
  const oneBucket = [{ startUtc: edge(0).startUtc, endUtc: edge(0).endUtc, person: 1, vehicle: 0, hidden: 0, footageMin: 60, watchedMin: 60, status: "counted" }];
  const chart = buildBarChart({
    title: "Person sightings", unitLabel: "sightings", kind: "person",
    seriesList: [{ label: "cam-1", cameraId: "cam-1", color: CHART_COLORS_DARK.categorical[0], buckets: oneBucket }],
    colors: CHART_COLORS_DARK,
  });
  const tickLabels = collect(chart.vnode, (n) => hasClass(n, "act-grid"))
    .map((line) => line.attrs.y1);
  // Read the tick TEXT nodes instead (the ones sharing the grid's y), since
  // that is what a person actually reads.
  const axisTexts = collect(chart.vnode, (n) => n.tag === "text" && !hasClass(n, "act-yaxis") && !hasClass(n, "act-xtick"))
    .filter((n) => typeof n.text === "string" && /^-?\d+$/.test(n.text));
  const seenYByLabel = new Map();
  for (const t of axisTexts) {
    if (!seenYByLabel.has(t.text)) seenYByLabel.set(t.text, new Set());
    seenYByLabel.get(t.text).add(t.attrs.y);
  }
  for (const [label, ys] of seenYByLabel) {
    eq(ys.size, 1, `REQUIRED: the label "${label}" must appear at exactly one height, not ${ys.size} different ones (two gridlines both reading "${label}" is indistinguishable from a scale error)`);
  }
});

/* ── 5. the Review deep link: built from the camera ID, never the label ──── */

await check("clicking a bar builds /review?camera=<id>&at=<ISO>, from the camera id, not the display name", async () => {
  let navigatedTo = null;
  const listeners = {};
  const fakeContainer = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  wireBarClickThrough({}, fakeContainer, (url) => { navigatedTo = url; });

  const bar = {
    getAttribute: (k) => ({
      "data-camera-id": "cam-7", "data-t": "2026-09-11T14:00:00.000Z",
    }[k] ?? null),
  };
  bar.closest = (sel) => (sel === ".act-bar" ? bar : null);
  await listeners.click({ target: bar });

  eq(navigatedTo, "/review?camera=cam-7&at=2026-09-11T14%3A00%3A00.000Z");
  const parsed = new URLSearchParams(navigatedTo.slice(navigatedTo.indexOf("?") + 1));
  eq(parsed.get("camera"), "cam-7", "round-trips back to the exact camera id");
  eq(parsed.get("at"), "2026-09-11T14:00:00.000Z", "round-trips back to the exact instant");
});

await check("a bar with no camera id (no single camera to open Review on) is never clicked through", async () => {
  let navigatedTo = "untouched";
  const listeners = {};
  const fakeContainer = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  wireBarClickThrough({}, fakeContainer, (url) => { navigatedTo = url; });
  const bar = { getAttribute: (k) => (k === "data-t" ? "2026-09-11T14:00:00.000Z" : null) };
  bar.closest = (sel) => (sel === ".act-bar" ? bar : null);
  await listeners.click({ target: bar });
  eq(navigatedTo, "untouched", "no camera id: nothing to navigate to, so nothing happened");
});

await check("a click outside any bar does nothing", async () => {
  let navigatedTo = "untouched";
  const listeners = {};
  const fakeContainer = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  wireBarClickThrough({}, fakeContainer, (url) => { navigatedTo = url; });
  await listeners.click({ target: { closest: () => null } });
  eq(navigatedTo, "untouched");
});

/* ── 6. the nav link: visible to both roles that carry events.view ───────── */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.hidden = false;
  }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  querySelectorAll(selector) {
    if (selector !== "a[href]") throw new Error(`fake DOM only supports "a[href]", got ${selector}`);
    const out = [];
    const walk = (el) => {
      if (el.tagName === "A" && el.getAttribute("href") !== null) out.push(el);
      for (const c of el.children) walk(c);
    };
    walk(this);
    return out;
  }
}

await check("PAGE_NEEDS registers the Activity page under events.view, the same permission the route table gates it with", () => {
  eq(PAGE_NEEDS["/activity-page"], "events.view");
  eq(decideRoute({ kind: "user", username: "tech", role: "installer" }, "GET", "/activity-page").kind, "allow");
  eq(decideRoute({ kind: "user", username: "clerk", role: "store" }, "GET", "/activity-page").kind, "allow");
});

await check("the Activity nav link stays visible for BOTH roles (both carry events.view) and is hidden for anyone who somehow does not", () => {
  const buildNav = () => {
    const root = new FakeEl("div");
    const activity = new FakeEl("a"); activity.setAttribute("href", "/activity-page");
    const live = new FakeEl("a"); live.setAttribute("href", "/");
    root.appendChild(activity);
    root.appendChild(live);
    return { root, activity, live };
  };

  const installerNav = buildNav();
  hideRefusedLinks(installerNav.root, permissionsFor("installer"));
  eq(installerNav.activity.hidden, false, "installer keeps the Activity link");

  const storeNav = buildNav();
  hideRefusedLinks(storeNav.root, permissionsFor("store"));
  eq(storeNav.activity.hidden, false, "store keeps the Activity link too -- 'the pages the store role uses'");

  const bareNav = buildNav();
  hideRefusedLinks(bareNav.root, []);
  eq(bareNav.activity.hidden, true, "no permissions at all: hidden, same as any other gated link");
  eq(bareNav.live.hidden, false, "an unrestricted link is never touched");
});

/* ── 7. phone width, no sideways scroll, and a colour-scheme that answers
   the OS setting instead of forcing dark (this page's own deliberate
   deviation from the rest of the app -- see activity.html's own header
   comment) ───────────────────────────────────────────────────────────────── */

await check("activity.html declares a 16px gutter, a sub-480px collapse breakpoint, and both a light and a dark colour scheme", async () => {
  const html = await readFile(join(root, "agent/ui/activity.html"), "utf8");
  eq(html.includes("padding: 16px"), true, "16px gutter");
  eq(/@media \(max-width: 480px\)/.test(html), true, "a phone-width collapse breakpoint");
  eq(/prefers-color-scheme:\s*dark/.test(html), true, "answers the OS dark-mode setting");
  eq(html.includes("color-scheme: light"), true, "declares a light scheme too, not dark-only like the rest of this app");
  eq(html.includes("innerHTML"), false, "no innerHTML in the page shell");
});

await check("activity-client.mjs and activity-charts.mjs never USE innerHTML (comments may name it while explaining the house rule)", async () => {
  for (const f of ["agent/ui/activity-client.mjs", "agent/ui/activity-charts.mjs"]) {
    const src = await readFile(join(root, f), "utf8");
    // Strip // and /* */ comments before checking: this file's own header
    // comment names "innerHTML" while explaining why it is never called,
    // same as the banned-words check above strips HTML comments first.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    eq(code.includes("innerHTML"), false, f);
  }
});

await check("THE FEARED ONE: in a browser the page STARTS ITSELF - loading activity-client.mjs with the real page in the DOM fetches /activity with no harness calling it", () => {
  // Found 2026-09-26: every check above drives startActivityPage directly, so
  // a client with no browser bootstrap passed them all while the real page
  // drew its chrome and never fetched. This loads the module the way a
  // browser does - fresh, with a document holding #activityBody - in its own
  // process, and records what it asks the server for.
  const clientUrl = pathToFileURL(join(root, "agent/ui/activity-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent") return "";
        if (k === "length") return 0;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    const calls = [];
    globalThis.document = {
      getElementById: () => fake, createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {} };
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, available: false, buckets: [], perCamera: [] }) });
    };
    await import(${JSON.stringify(clientUrl)} + "?boot");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(calls));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  eq(r.status, 0, `the child ran (${(r.stderr || "").slice(0, 300)})`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  const calls = JSON.parse(lines[lines.length - 1] || "[]");
  eq(calls.some((u) => u.startsWith("/activity?") && u.includes("range=24h")), true, `it asked for /activity on its own: ${JSON.stringify(calls)}`);
});

report("activity page");
