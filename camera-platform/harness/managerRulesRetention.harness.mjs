/**
 * Manager rules' own retention (agent/event-retention.mjs's runManagerRulesRetention),
 * against REAL temporary sqlite files (occupancy.db, rules.db, index.db) —
 * MANAGER-RULES-SPEC.md: "Kept as long as the video: transitions and rule
 * firings older than the camera's oldest footage are deleted by the existing
 * events-retention pass ... with the same horizon and margin."
 *
 * THE FEARED FAILURE, the same one EVENTS-RETENTION-SPEC.md names for
 * events: a transition or a firing deleted while ITS video remains, or a
 * camera whose footage horizon is unknown having anything guessed about it
 * (build rule 10) instead of being kept whole and named as such.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOccupancyDb } from "../agent/occupancy-db.mjs";
import { openRulesDb } from "../agent/rules-db.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { runManagerRulesRetention, EVENT_RETENTION_MARGIN_MS } from "../agent/event-retention.mjs";
import { evaluateManagerRule } from "../dist/managerRules.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("managerRulesRetention");

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-23T00:00:00.000Z");
const NOW = Date.parse("2026-09-23T06:00:00.000Z");
const MARGIN = EVENT_RETENTION_MARGIN_MS;
const now = () => new Date(NOW);

function seg(cameraId, startMs, { lengthMs = 60_000, root = "/d0", state = "sealed" } = {}) {
  return {
    cameraId, startUtc: iso(startMs), endUtc: iso(startMs + lengthMs),
    path: `${cameraId}/${startMs}.mp4`, bytes: 1000, state, hold: false, pendingUpload: false, bitrateKbps: 2000, root,
  };
}

function site() {
  const dir = mkdtempSync(join(tmpdir(), "camplat-mgrretention-"));
  return {
    dir,
    openOcc: () => openOccupancyDb(join(dir, "occupancy.db")),
    openRules: () => openRulesDb(join(dir, "rules.db")),
    openIdx: () => openIndex(join(dir, "index.db")),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const firing = (cameraId, startMs, overrides = {}) => ({
  ruleId: "r1", ruleName: "Manager's desk unattended", cameraId, areaId: "a1", kind: "person",
  what: "absent_longer_than", complete: true, startMs, endMs: startMs + 60_000, durationMs: 60_000,
  text: "x", alertWanted: false, reportWanted: true, ...overrides,
});

await check("REQUIRED: transitions and firings entirely before the footage horizon (less the margin) are deleted; newer ones are kept", async () => {
  const s = site();
  try {
    const idx = s.openIdx();
    idx.put(seg("cam1", T0)); // footage starts at T0
    const occ = s.openOcc();
    occ.insert({ areaId: "a1", cameraId: "cam1", kind: "person", state: "absent", atMs: T0 - 2 * 3600_000 }); // well before
    occ.insert({ areaId: "a1", cameraId: "cam1", kind: "person", state: "present", atMs: T0 + 3600_000 }); // after
    const rdb = s.openRules();
    rdb.insert(firing("cam1", T0 - 2 * 3600_000));
    rdb.insert(firing("cam1", T0 + 3600_000));

    const result = await runManagerRulesRetention({ occupancyDb: occ, rulesDb: rdb, index: idx, now });
    eq(result.error, null);
    eq(result.occupancyDeleted, 1, "the old transition, and only it");
    eq(result.firingsDeleted, 1, "the old firing, and only it");
    eq(result.cameras, [{ cameraId: "cam1", footageFromUtc: iso(T0) }]);
    eq(result.kept, []);

    eq(occ.all().length, 1, "the newer transition survives");
    eq(occ.all()[0].state, "present");
    eq(rdb.all().length, 1, "the newer firing survives");
    eq(rdb.all()[0].startMs, T0 + 3600_000);

    occ.close(); rdb.close(); idx.close();
  } finally {
    s.done();
  }
});

await check("THE FEARED ONE: a row exactly at the threshold (footage start minus margin) is NEVER deleted", async () => {
  const s = site();
  try {
    const idx = s.openIdx();
    idx.put(seg("cam1", T0));
    const occ = s.openOcc();
    occ.insert({ areaId: "a1", cameraId: "cam1", kind: "person", state: "absent", atMs: T0 - MARGIN }); // exactly at the boundary: kept
    const result = await runManagerRulesRetention({ occupancyDb: occ, rulesDb: null, index: idx, now });
    eq(result.occupancyDeleted, 0, "at_ms < beforeMs is strict: the boundary itself survives");
    eq(occ.all().length, 1);
    occ.close(); idx.close();
  } finally {
    s.done();
  }
});

await check("REQUIRED: a camera with no footage in the index keeps every row, reported as no_footage_in_index -- never guessed at", async () => {
  const s = site();
  try {
    const idx = s.openIdx(); // no segments for cam1 at all
    const occ = s.openOcc();
    occ.insert({ areaId: "a1", cameraId: "cam1", kind: "person", state: "absent", atMs: T0 - 999 * 3600_000 });
    const rdb = s.openRules();
    rdb.insert(firing("cam1", T0 - 999 * 3600_000));

    const result = await runManagerRulesRetention({ occupancyDb: occ, rulesDb: rdb, index: idx, now });
    eq(result.occupancyDeleted, 0);
    eq(result.firingsDeleted, 0);
    same(result.kept, [{ cameraId: "cam1", events: 1, reason: "no_footage_in_index" }],
      "one keep entry, not two -- occupancy's 1 row and firings' 1 row for the SAME camera collapse to a single named reason");
    eq(occ.all().length, 1, "nothing guessed away");
    eq(rdb.all().length, 1);

    occ.close(); rdb.close(); idx.close();
  } finally {
    s.done();
  }
});

await check("several cameras are decided independently: one's footage never lends its horizon to another", async () => {
  const s = site();
  try {
    const idx = s.openIdx();
    idx.put(seg("cam-a", T0));
    idx.put(seg("cam-b", T0 - 5 * 3600_000)); // cam-b's footage goes back further
    const occ = s.openOcc();
    occ.insert({ areaId: "a1", cameraId: "cam-a", kind: "person", state: "absent", atMs: T0 - 3600_000 }); // before cam-a's horizon: pruned
    occ.insert({ areaId: "a2", cameraId: "cam-b", kind: "person", state: "absent", atMs: T0 - 3600_000 }); // after cam-b's own horizon: kept

    const result = await runManagerRulesRetention({ occupancyDb: occ, rulesDb: null, index: idx, now });
    eq(result.occupancyDeleted, 1);
    const remaining = occ.all();
    eq(remaining.length, 1);
    eq(remaining[0].cameraId, "cam-b", "cam-b's own row, judged against its own (earlier) footage horizon, survives");

    occ.close(); idx.close();
  } finally {
    s.done();
  }
});

await check("REQUIRED: neither source open is a plain no-op result, never an error", async () => {
  const s = site();
  try {
    const idx = s.openIdx();
    const result = await runManagerRulesRetention({ occupancyDb: null, rulesDb: null, index: idx, now });
    same(result, { atUtc: iso(NOW), marginMs: MARGIN, occupancyDeleted: 0, firingsDeleted: 0, cameras: [], kept: [], error: null });
    idx.close();
  } finally {
    s.done();
  }
});

await check("only occupancyDb is open (a site that never had a rule fire yet): firings retention is simply skipped, not an error", async () => {
  const s = site();
  try {
    const idx = s.openIdx();
    idx.put(seg("cam1", T0));
    const occ = s.openOcc();
    occ.insert({ areaId: "a1", cameraId: "cam1", kind: "person", state: "absent", atMs: T0 - 3600_000 });
    const result = await runManagerRulesRetention({ occupancyDb: occ, rulesDb: null, index: idx, now });
    eq(result.error, null);
    eq(result.occupancyDeleted, 1);
    eq(result.firingsDeleted, 0);
    occ.close(); idx.close();
  } finally {
    s.done();
  }
});

await check("an index that cannot be read is refused whole, as an error -- nothing deleted from either source", async () => {
  const s = site();
  try {
    const occ = s.openOcc();
    occ.insert({ areaId: "a1", cameraId: "cam1", kind: "person", state: "absent", atMs: T0 - 3600_000 });
    const brokenIndex = { earliestFor: () => { throw new Error("index corrupt"); } };
    const result = await runManagerRulesRetention({ occupancyDb: occ, rulesDb: null, index: brokenIndex, now });
    eq(typeof result.error, "string");
    eq(result.occupancyDeleted, 0);
    eq(occ.all().length, 1, "nothing deleted when the plan itself could not be built");
    occ.close();
  } finally {
    s.done();
  }
});

/* ------------------------------------------------------------------ */
/* Build gap 2: firings must be idempotent IN STORAGE, not only through */
/* the evaluator's own cooldown/lastFiredAtMs gate (agent/rules-db.mjs's */
/* UNIQUE index on (rule_id, what, start_ms), INSERT OR IGNORE).        */
/* ------------------------------------------------------------------ */

const idemRule = (overrides = {}) => ({
  id: "r-idem", name: "Manager's desk unattended", enabled: true, template: "desk_unattended",
  cameraId: "cam1", areaId: "a1", kind: "person",
  condition: { type: "absent_longer_than", minutes: 20 }, when: "always",
  notify: { alert: true, report: true, cooldownMinutes: 0 },
  createdBy: "tech", updatedUtc: iso(T0), updatedBy: "tech",
  ...overrides,
});
// present, then absent long enough to cross the 20-minute threshold.
const idemTransitions = [
  { state: "present", atMs: T0 },
  { state: "absent", atMs: T0 + 1_000 },
];
const idemNowMs = T0 + 1_000 + 20 * 60_000 + 5_000; // well after the crossing

await check("REQUIRED: evaluating the SAME transitions twice with lastFiredAtMs deliberately reset to null stores exactly one row", async () => {
  const s = site();
  try {
    const rdb = s.openRules();
    const rule = idemRule();

    // First evaluator pass: a normal, from-scratch evaluation.
    const firstPass = evaluateManagerRule(rule, idemTransitions, idemNowMs, null, "UTC", null);
    eq(firstPass.length, 1, "one absent_longer_than crossing");
    for (const f of firstPass) rdb.insert(f);

    // A SECOND pass over the exact same transitions, with lastFiredAtMs
    // deliberately reset to null -- exactly what a restarted evaluator, or
    // an overlapping tick, would hand evaluateManagerRule if it could not
    // read rules.db's own lastFiredAtMs back in time. Without this file's
    // own UNIQUE index this would double the row count.
    const secondPass = evaluateManagerRule(rule, idemTransitions, idemNowMs, null, "UTC", null);
    eq(secondPass.length, 1, "the reader re-derives the identical candidate -- lastFiredAtMs is null again");
    eq(secondPass[0].startMs, firstPass[0].startMs, "the SAME real event, not a new one");
    for (const f of secondPass) rdb.insert(f);

    eq(rdb.all().length, 1, "storage caught the duplicate the reader could not rule out on its own");
    rdb.close();
  } finally {
    s.done();
  }
});

await check("REQUIRED: renaming a rule and re-evaluating stores no second row, and the stored name stays the ORIGINAL snapshot", async () => {
  const s = site();
  try {
    const rdb = s.openRules();
    const original = idemRule({ name: "Manager's desk unattended" });
    const firstPass = evaluateManagerRule(original, idemTransitions, idemNowMs, null, "UTC", null);
    eq(firstPass.length, 1);
    for (const f of firstPass) rdb.insert(f);
    eq(rdb.all()[0].ruleName, "Manager's desk unattended");

    // The rule is renamed, and (the same lastFiredAtMs-unavailable scenario
    // as above) re-evaluated over the SAME underlying transitions -- same
    // rule_id, same what, same start_ms, only rule_name differs.
    const renamed = idemRule({ name: "Front desk empty too long" });
    const secondPass = evaluateManagerRule(renamed, idemTransitions, idemNowMs, null, "UTC", null);
    eq(secondPass.length, 1);
    eq(secondPass[0].ruleName, "Front desk empty too long", "the CANDIDATE carries the new name -- it is storage's job to refuse it, not the evaluator's");
    for (const f of secondPass) rdb.insert(f);

    const rows = rdb.all();
    eq(rows.length, 1, "no second row from the rename");
    eq(rows[0].ruleName, "Manager's desk unattended", "build rule 7: a firing keeps the name it had -- INSERT OR IGNORE never updates it");
    rdb.close();
  } finally {
    s.done();
  }
});

report("managerRulesRetention");
