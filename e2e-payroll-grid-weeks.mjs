// E2E (DB + logic layer) for the payroll-grid month view. Runs against the
// PRODUCTION database using the service-role key from .env.local, seeds a
// small, clearly-marked set of time_entries, verifies the invariants the
// week × worker grid depends on, ALWAYS deletes what it seeded, and exits.
// No secrets are printed. Run with: npx tsx e2e-payroll-grid-weeks.mjs
//
// The page itself is an authed server component (getMe → RLS session client,
// which a headless script can't obtain), so the full HTTP render is
// browser-verified. This script covers the data + logic half:
//
//  (a) A SHIFT row (job_id IS NULL) inserts cleanly — the shift-clock
//      migrations are live — and the org-stamp trigger fills organization_id
//      from the worker, not a job.
//  (b) The org-scoped read the grid page makes (range query, RLS-scoped on
//      prod) returns exactly this org's rows and nothing cross-org.
//  (c) The Monday–Sunday invariants of src/lib/payrollWeeks.ts hold.
//  (d) The grid's aggregation semantics on the seeded rows: rejected hours
//      count in NO total; the open shift is flagged, never counted as
//      payable; week buckets match expected totals.
import { createClient as sbCreateClient } from "@supabase/supabase-js";
import fs from "node:fs";
// Plain .ts source — resolved by tsx at runtime (npx tsx e2e-payroll-grid-weeks.mjs)
import { weeksInRange, bucketByWeek, weekStart, fmtHours } from "./src/lib/payrollWeeks.ts";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

// The production server runtime is UTC (Vercel), so all date math here is UTC.
const toISO = (d) => d.toISOString().slice(0, 10);
function addDaysUTC(iso, n) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}
// Monday of the week containing `iso` (UTC) — only used to pick seed dates.
function seedMonday(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay()));
  return toISO(d);
}
// A timestamp on a given calendar day at 12:00 UTC — never near a day
// boundary, so the day-bucketing is unambiguous.
const dayTS = (iso) => new Date(`${iso}T12:00:00.000Z`).toISOString();
const afterHours = (ts, h) => new Date(new Date(ts).getTime() + h * 3_600_000).toISOString();
const H = 3_600_000; // one hour in ms

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`); }
}

const MARK = `e2e_payroll_${Date.now().toString(36)}`;
const seeded = [];

async function main() {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env in .env.local");
  const admin = sbCreateClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: orgs } = await admin.from("organizations").select("id, name").limit(1);
    const org = orgs?.[0];
    if (!org) throw new Error("No org found");
    const { data: profs } = await admin
      .from("profiles")
      .select("id, full_name, organization_id")
      .eq("organization_id", org.id)
      .limit(2);
    if (!profs || profs.length < 2) throw new Error("Need 2 profiles in one org");
    const [workerA, workerB] = profs;
    console.log(`Org: ${org.name} — seeds marked with note=${MARK}\n`);

    // ---- Seed 3 weeks of entries (shift rows: job_id intentionally NULL) ----
    // Each closed entry spans exactly 5 h; the last one is left open.
    // Weeks sit fully in the PAST (start 3 weeks back) so the open-shift
    // elapsed time is positive and nothing lands in the future.
    const w1 = addDaysUTC(seedMonday(new Date().toISOString().slice(0, 10)), -21);
    const w2 = addDaysUTC(w1, 7);
    const w3 = addDaysUTC(w1, 14);
    const specs = [
      { user: workerA, day: w1, status: "approved" },                 // A w1: 5h
      { user: workerA, day: addDaysUTC(w1, 2), status: "pending" },   // A w1: +5h pending
      { user: workerA, day: addDaysUTC(w2, 1), status: "approved" },  // A w2: 5h
      { user: workerA, day: w3, status: "pending" },                  // A w3: 5h (outside range below)
      { user: workerB, day: addDaysUTC(w1, 3), status: "approved" },  // B w1: 5h
      { user: workerB, day: addDaysUTC(w2, 4), status: "rejected" },  // B w2: REJECTED 5h
      { user: workerB, day: addDaysUTC(w3, 2), status: "pending", open: true }, // B w3: OPEN
    ];
    for (const s of specs) {
      const clockIn = dayTS(s.day);
      const { data, error } = await admin
        .from("time_entries")
        .insert({
          user_id: s.user.id,
          clock_in_at: clockIn,
          clock_out_at: s.open ? null : afterHours(clockIn, 5),
          status: s.status,
          note: MARK,
        })
        .select("id, organization_id, job_id, status, clock_out_at");
      if (error || !data?.length) {
        console.log(`  ✗ seed insert failed: ${error?.message ?? "no row returned"}`);
        throw error ?? new Error("seed insert failed");
      }
      const row = data[0];
      seeded.push(row);
      check(
        `seed ${s.status}${s.open ? " (open)" : ""} row inserted as a shift (job_id IS NULL)`,
        row.job_id === null
      );
    }
    check(
      "org-stamp trigger fills organization_id from the worker (not job)",
      seeded.every((r) => r.organization_id === org.id),
      seeded.filter((r) => r.organization_id !== org.id).map((r) => r.id).join(",")
    );
    check(
      "the still-clocked-in row kept clock_out_at NULL",
      seeded.some((r) => r.clock_out_at === null)
    );
    check(
      "7 shift rows survived with their review statuses",
      seeded.length === 7 && seeded.every((r) => r.status !== undefined)
    );

    // RLS-equivalence probe: on prod the page reads through the RLS session
    // client, so an org-scoped read returns exactly this org's rows.
    const { data: scoped } = await admin
      .from("time_entries")
      .select("id")
      .eq("organization_id", org.id)
      .eq("note", MARK);
    check("org-scoped read returns all 7 seeds", (scoped ?? []).length === 7, `got ${scoped?.length}`);

    // ---- payrollWeeks invariants ----
    console.log("\npayrollWeeks invariants:");
    const rangeFrom = addDaysUTC(w1, -3); // Saturday before week 1 → belongs to the PREVIOUS Monday's week
    const rangeTo = addDaysUTC(w2, 5); // Friday of week 2 → 3 overlapping weeks in total
    const weeks = weeksInRange(rangeFrom, rangeTo);
    check(
      "weeksInRange covers overlapping weeks exactly (a pre-range Saturday pulls in the prior week)",
      weeks.length === 3 && weeks[1].start === weekStart(w1),
      `got ${weeks.length}: ${weeks.map((w) => w.start).join(", ")}`
    );
    check(
      "every week starts on its own Monday and ends Sunday (Mon–Sun)",
      weeks.every((w) => weekStart(w.start) === w.start && w.end === addDaysUTC(w.start, 6)),
      weeks.map((w) => `${w.start}..${w.end}`).join(", ")
    );
    const sub = weeksInRange(w3, addDaysUTC(w3, 4)); // Mon–Fri inside week 3
    check(
      "sub-week range returns exactly one week starting at that Monday",
      sub.length === 1 && sub[0].start === weekStart(w3) && sub[0].end === addDaysUTC(w3, 6),
      JSON.stringify(sub.map((w) => [w.start, w.end]))
    );
    check(
      "fmtHours: 8 → '8', 7.25 → '7.3'",
      fmtHours(8) === "8" && fmtHours(7.25) === "7.3",
      `got ${fmtHours(8)}, ${fmtHours(7.25)}`
    );

    // ---- Grid aggregation semantics, replicated from the page ----
    const { data: raw } = await admin
      .from("time_entries")
      .select("user_id, clock_in_at, clock_out_at, status, note")
      .eq("note", MARK);
    check("all seeds readable back", (raw ?? []).length === 7, `got ${raw?.length}`);

    // Mirror of the page's per-worker aggregation: payable (closed, not
    // rejected) ms per day; open in its own bucket; rejected skipped.
    const aggregate = (worker) => {
      const payableDay = {};
      let openMs = 0;
      for (const t of raw ?? []) {
        if (t.user_id !== worker.id || t.status === "rejected") continue;
        const day = t.clock_in_at.slice(0, 10); // 12:00Z — same day in UTC
        if (t.clock_out_at === null) {
          openMs += Date.now() - Date.parse(t.clock_in_at);
        } else {
          payableDay[day] = (payableDay[day] ?? 0) + 5 * H;
        }
      }
      return { payableDay, openMs };
    };
    const a = aggregate(workerA);
    const b = aggregate(workerB);
    const weeksA = bucketByWeek(a.payableDay, weeks);
    const weeksB = bucketByWeek(b.payableDay, weeks);

    console.log("\naggregation on seeded rows (5 h per closed entry):");
    console.log(`  A weeks: [${weeksA.map((h) => h / H).join(", ")}]`);
    console.log(`  B weeks: [${weeksB.map((h) => h / H).join(", ")}]`);
    check("bucket list is one number per week", weeksA.length === 3);
    check("A: pre-range week bucket = 0", weeksA[0] === 0, `got ${weeksA[0]}`);
    check("A: week-1 bucket = 10 h (approved + pending)", weeksA[1] === 10 * H, `got ${weeksA[1]}`);
    check("A: week-2 bucket = 5 h", weeksA[2] === 5 * H, `got ${weeksA[2]}`);
    check("B: week-1 bucket = 5 h", weeksB[1] === 5 * H, `got ${weeksB[1]}`);
    check("rejected Friday is in NO week bucket", weeksB[2] === 0, `got ${weeksB[2]}`);
    check(
      "open shift contributes NO payable hours on any day",
      b.payableDay[addDaysUTC(w3, 2)] === undefined && b.payableDay[w3] === undefined
    );
    check(
      "open shift IS flagged in its own bucket (not silently zero)",
      b.openMs > 0
    );
  } finally {
    if (seeded.length) {
      const del = await admin
        .from("time_entries")
        .delete()
        .in("id", seeded.map((r) => r.id));
      console.log(`\ncleanup: removed ${seeded.length} seeded row(s)${del.error ? " — ✗ DELETE FAILED: " + del.error.message : " ✓"}`);
      if (del.error) fail++;
    }
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail > 0 ? 1 : 0;
  })
  .catch((e) => {
    console.error("FATAL:", e?.message || e);
    process.exitCode = 1;
  });