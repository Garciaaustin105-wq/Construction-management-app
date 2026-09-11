/**
 * Scale: a full retention period in the index.
 *
 * 16 cameras x 60s segments x 30 days = 691,200 rows. Everything built on top
 * of the index assumes it stays fast at that size; this finds out before a
 * store does.
 */
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIndex } from "../agent/segindex.mjs";
import { planEviction } from "../dist/eviction.js";
import { buildTimeline, coalesceForDisplay } from "../dist/segment.js";
import { planEvictionScalable } from "../agent/evict.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("scale (30 days, 16 cameras, 691,200 segments)");

const CAMERAS = 16;
const SEG_SECONDS = 60;
const DAYS = 30;
const PER_CAMERA = (DAYS * 86400) / SEG_SECONDS;      // 43,200
const TOTAL = CAMERAS * PER_CAMERA;                    // 691,200
const SEG_BYTES = 18_750_000;                          // 60s at 2.5 Mbps
const START_MS = Date.UTC(2026, 7, 12, 0, 0, 0);

const stateDir = await mkdtemp(path.join(tmpdir(), "camplat-scale-"));
const dbPath = path.join(stateDir, "index.db");
const index = openIndex(dbPath);

const ms = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

// ---- populate -------------------------------------------------------------
let inserted = 0;
const genStart = process.hrtime.bigint();
for (let c = 0; c < CAMERAS; c++) {
  const cameraId = `cam-${String(c + 1).padStart(2, "0")}`;
  const batch = [];
  for (let i = 0; i < PER_CAMERA; i++) {
    const startMs = START_MS + i * SEG_SECONDS * 1000;
    batch.push({
      cameraId,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(startMs + SEG_SECONDS * 1000).toISOString(),
      path: `${cameraId}/${startMs}.mp4`,
      bytes: SEG_BYTES,
      state: "sealed",
      hold: false,
      pendingUpload: false,
      bitrateKbps: 2500,
    });
    if (batch.length === 10_000) { index.putMany(batch.splice(0)); inserted += 10_000; }
  }
  if (batch.length) { index.putMany(batch); inserted += batch.length; }
}
const genMs = Number(process.hrtime.bigint() - genStart) / 1e6;
const dbBytes = (await stat(dbPath)).size;

console.log(`  populated ${inserted.toLocaleString()} rows in ${(genMs / 1000).toFixed(1)}s ` +
  `(${Math.round(inserted / (genMs / 1000)).toLocaleString()}/s)`);
console.log(`  db size   ${(dbBytes / 1e6).toFixed(0)} MB  (${Math.round(dbBytes / inserted)} bytes/row)\n`);

check("the index holds a full retention period", () => {
  eq(index.count(), TOTAL, "row count");
});

check("sealing keeps up with 16 cameras — needs 0.27 writes/sec, sustained", () => {
  const perSec = inserted / (genMs / 1000);
  const required = CAMERAS / SEG_SECONDS;              // 0.27/s
  if (perSec < required * 1000) throw new Error(`only ${perSec.toFixed(0)}/s`);
  console.log(`       ${Math.round(perSec).toLocaleString()}/s vs ${required.toFixed(2)}/s needed — ${Math.round(perSec / required).toLocaleString()}x headroom`);
});

check("db stays small enough to sit on the OS NVMe", () => {
  if (dbBytes > 500e6) throw new Error(`${(dbBytes / 1e6).toFixed(0)} MB is too large for a 128 GB OS drive to carry comfortably`);
});

// ---- the hot path: a timeline query --------------------------------------
check("THE HOT PATH: a 4-hour timeline for one camera is fast", () => {
  const from = new Date(START_MS + 15 * 86400_000).toISOString();
  const to = new Date(START_MS + 15 * 86400_000 + 4 * 3600_000).toISOString();
  const [rows, queryMs] = ms(() => index.inRange("cam-08", from, to));
  eq(rows.length, 240, "segments in 4 hours");
  console.log(`       query ${queryMs.toFixed(1)}ms, buildTimeline over ${rows.length} rows`);
  if (queryMs > 100) throw new Error(`${queryMs.toFixed(0)}ms — a scrub would feel sluggish`);

  const [timeline, buildMs] = ms(() => buildTimeline("cam-08", rows.map((r) => ({
    cameraId: r.cameraId, startUtc: r.startUtc, endUtc: r.endUtc, tier: "edge",
    key: null, bytes: r.bytes, codec: "h265", bitrateKbps: r.bitrateKbps,
  })), { startUtc: from, endUtc: to }));
  eq(timeline.length, 240, "one span per file — buildTimeline preserves file identity");
  if (buildMs > 50) throw new Error(`buildTimeline took ${buildMs.toFixed(0)}ms`);

  // Rendering wants the opposite: where is there recording, and where is there not.
  const [display] = ms(() => coalesceForDisplay(timeline));
  eq(display.length, 1, "240 abutting files render as one unbroken band");
  eq(display[0].key, null, "a merged span is no longer a single file");
});

check("a whole-day timeline for one camera is still interactive", () => {
  const from = new Date(START_MS + 10 * 86400_000).toISOString();
  const to = new Date(START_MS + 11 * 86400_000).toISOString();
  const [rows, queryMs] = ms(() => index.inRange("cam-03", from, to));
  eq(rows.length, 1440, "segments in a day");
  console.log(`       ${rows.length} rows in ${queryMs.toFixed(1)}ms`);
  if (queryMs > 250) throw new Error(`${queryMs.toFixed(0)}ms`);
});

// ---- eviction: the one that worried me -----------------------------------
check("THE FEARED ONE: eviction is bounded, not a full index load", () => {
  const [plan, planMs] = ms(() => planEvictionScalable(index, SEG_BYTES * 100));
  console.log(`       planEvictionScalable: ${planMs.toFixed(0)}ms, ${plan.pagesRead} page(s) read`);
  eq(plan.kind, "ok", "plan");
  eq(plan.evict.length, 100, "evicts exactly what is needed");
  eq(plan.pagesRead, 1, "one page was enough");
  if (planMs > 100) throw new Error(`${planMs.toFixed(0)}ms — still too slow`);
});

check("the naive approach is measurably worse — this is why the bounded one exists", () => {
  const [all, loadMs] = ms(() => index.all());
  const [, planMs] = ms(() => planEviction(all, SEG_BYTES * 100));
  const naive = loadMs + planMs;
  const [, boundedMs] = ms(() => planEvictionScalable(index, SEG_BYTES * 100));
  console.log(`       naive ${naive.toFixed(0)}ms (~${((all.length * 260) / 1e6).toFixed(0)} MB) vs bounded ${boundedMs.toFixed(0)}ms`);
  if (naive < boundedMs * 10) throw new Error("expected the bounded path to be far faster");
});

check("a large eviction pages up rather than failing", () => {
  const [plan, planMs] = ms(() => planEvictionScalable(index, SEG_BYTES * 2000));
  eq(plan.kind, "ok", "plan");
  eq(plan.evict.length, 2000, "freed what was asked");
  console.log(`       2,000 segments: ${planMs.toFixed(0)}ms, ${plan.pagesRead} page(s)`);
  if (plan.pagesRead < 2) throw new Error("expected paging beyond the first 512");
});

check("held and pending-upload segments never enter the candidate set at all", () => {
  const victims = index.oldestEvictable(3);
  for (const v of victims) index.put({ ...v, hold: true });
  const plan = planEvictionScalable(index, SEG_BYTES * 5);
  for (const c of plan.evict) {
    if (victims.some((v) => v.path === c.segment.path)) {
      throw new Error("a held segment reached the planner — SQL filter is wrong");
    }
  }
  for (const v of victims) index.put({ ...v, hold: false });
});

check("total bytes across the estate is a single aggregate, not a scan", () => {
  const [total, aggMs] = ms(() => index.totalBytes());
  eq(total, TOTAL * SEG_BYTES, "sums correctly");
  console.log(`       totalBytes() ${aggMs.toFixed(1)}ms`);
  if (aggMs > 500) throw new Error(`${aggMs.toFixed(0)}ms`);
});

index.close();
await rm(stateDir, { recursive: true, force: true });
report("scale");
