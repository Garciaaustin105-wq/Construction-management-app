// E2E (DB-layer) for Track 3: lawn estimate → separately-scheduled jobs.
// Verifies the conversion's data-model invariants by replicating the convert
// logic service-role (the route itself uses getMe → RLS session client, which a
// headless script can't easily obtain; the route's HTTP flow is browser-
// verified, matching the chemicals track where re_entry_until was the route's
// job). Reads .env.local. No secrets printed.
//
// Invariants checked:
//  (a) 2 schedules spawned on the job for the 2 schedulable lines.
//  (b) both schedulable line items stamped with recurring_schedule_id.
//  (c) the non-scheduled line is NOT stamped.
//  (d) each schedule insert triggered organization_id from job_id
//      (set_org_from_job) — the core tenant invariant.
//  (e) estimate status flips to 'converted' + converted_at set.
// Plus: one-time line → schedule bounded to start=end (one visit window).
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MARK = `__e2e_est_conv_${Date.now().toString(36)}__`;
let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

// Build a recurring_schedules insert payload from a line item (mirrors
// lineItemToScheduleRow in src/lib/lawnEstimate.ts). One-time → bounded.
function lineToSchedule(line, jobId, userId) {
  const start = line.schedule_start_date;
  if (line.schedule_frequency === "one-time") {
    const dow = new Date(`${start}T00:00:00.000Z`).getUTCDay();
    return {
      job_id: jobId, frequency: "one-time", interval_weeks: 1,
      days_of_week: [dow], day_of_month: null,
      start_date: start, end_date: start, // bounded → one visit
      service_type: line.description, price_per_visit: line.unit_price,
      active: true, created_by: userId,
    };
  }
  const interval = { weekly: 1, biweekly: 2, monthly: 4 }[line.schedule_frequency] ?? 1;
  return {
    job_id: jobId, frequency: line.schedule_frequency, interval_weeks: interval,
    days_of_week: line.schedule_frequency === "monthly" ? [] : line.schedule_days_of_week,
    day_of_month: line.schedule_frequency === "monthly" ? line.schedule_day_of_month : null,
    start_date: start, end_date: line.schedule_end_date ?? null,
    service_type: line.description, price_per_visit: line.unit_price,
    active: true, created_by: userId,
  };
}

async function main() {
  // 1. Find a lawn org + a user on it (for created_by).
  const { data: org, error: oErr } = await admin
    .from("organizations").select("id, name").eq("app_variant", "lawn").limit(1).single();
  if (oErr || !org) throw new Error(`No lawn org: ${oErr?.message ?? "none"}`);
  const { data: profile } = await admin
    .from("profiles").select("id").eq("organization_id", org.id).limit(1).single();
  const userId = profile?.id ?? null;
  console.log(`Lawn org: ${org.name} (${org.id})`);

  // 2. Test customer + lawn job.
  const { data: cust, error: cErr } = await admin.from("customers")
    .insert({ organization_id: org.id, name: `${MARK} Customer` })
    .select("id").single();
  if (cErr) throw new Error(`customer: ${cErr.message}`);
  const { data: job, error: jErr } = await admin.from("jobs")
    .insert({ organization_id: org.id, customer_id: cust.id, name: `${MARK} Job`, type: "lawn", status: "scheduled" })
    .select("id").single();
  if (jErr) throw new Error(`job: ${jErr.message}`);
  const { error: ljErr } = await admin.from("lawn_jobs").insert({ id: job.id, organization_id: org.id });
  if (ljErr && ljErr.code !== "23505") throw new Error(`lawn_jobs: ${ljErr.message}`);

  // 3. Approved estimate + 3 line items (weekly, one-time, non-scheduled).
  const { data: est, error: eErr } = await admin.from("estimates")
    .insert({ organization_id: org.id, job_id: job.id, customer_id: cust.id, title: `${MARK} Est`, status: "approved" })
    .select("id").single();
  if (eErr) throw new Error(`estimate: ${eErr.message}`);

  const seasonStart = "2026-03-01";
  const seasonEnd = "2026-10-31";
  const oneTimeDate = "2026-06-15";
  const lines = [
    { estimate_id: est.id, description: `${MARK} Mow`, quantity: 26, unit: "EA", unit_price: 40, position: 0,
      schedule_frequency: "weekly", schedule_interval_weeks: 1, schedule_days_of_week: [1], schedule_day_of_month: null,
      schedule_start_date: seasonStart, schedule_end_date: seasonEnd },
    { estimate_id: est.id, description: `${MARK} Aerate`, quantity: 1, unit: "EA", unit_price: 150, position: 1,
      schedule_frequency: "one-time", schedule_interval_weeks: 1, schedule_days_of_week: [], schedule_day_of_month: null,
      schedule_start_date: oneTimeDate, schedule_end_date: null },
    { estimate_id: est.id, description: `${MARK} Material`, quantity: 1, unit: "EA", unit_price: 25, position: 2,
      schedule_frequency: null, schedule_interval_weeks: 1, schedule_days_of_week: [], schedule_day_of_month: null,
      schedule_start_date: null, schedule_end_date: null },
  ];
  const { data: insertedLines, error: lErr } = await admin.from("estimate_line_items").insert(lines).select("id, schedule_frequency");
  if (lErr) throw new Error(`line_items: ${lErr.message}`);
  const [mowLine, aerateLine, materialLine] = insertedLines;

  // 4. Replicate conversion: insert a schedule per schedulable line, stamp it.
  const schedIds = [];
  for (const line of insertedLines) {
    if (!line.schedule_frequency) continue;
    const fullLine = lines.find((l) => l.description.startsWith(MARK) && l.schedule_frequency === line.schedule_frequency);
    const row = lineToSchedule({ ...fullLine, description: fullLine.description }, job.id, userId);
    const { data: sched, error: sErr } = await admin.from("recurring_schedules").insert(row).select("id, organization_id, start_date, end_date").single();
    if (sErr) throw new Error(`schedule insert: ${sErr.message}`);
    schedIds.push(sched.id);
    const { error: stampErr } = await admin.from("estimate_line_items").update({ recurring_schedule_id: sched.id }).eq("id", line.id);
    if (stampErr) throw new Error(`stamp: ${stampErr.message}`);

    // (d) trigger stamped organization_id from job_id.
    check(`schedule org stamped from job (${line.schedule_frequency})`, sched.organization_id === org.id);

    // one-time schedule is bounded (start=end).
    if (line.schedule_frequency === "one-time") {
      check("one-time schedule bounded start=end", sched.start_date === sched.end_date);
    }
  }

  // Flip estimate to converted.
  const { error: flipErr } = await admin.from("estimates")
    .update({ status: "converted", converted_at: new Date().toISOString() }).eq("id", est.id);
  if (flipErr) throw new Error(`flip: ${flipErr.message}`);

  // 5. Verify invariants.
  const { count: schedOnJob } = await admin.from("recurring_schedules").select("id", { count: "exact", head: true }).eq("job_id", job.id);
  check("(a) 2 schedules on the job", schedOnJob === 2);

  const { data: mowBack } = await admin.from("estimate_line_items").select("recurring_schedule_id").eq("id", mowLine.id).single();
  const { data: aerateBack } = await admin.from("estimate_line_items").select("recurring_schedule_id").eq("id", aerateLine.id).single();
  const { data: materialBack } = await admin.from("estimate_line_items").select("recurring_schedule_id").eq("id", materialLine.id).single();
  check("(b) weekly line stamped", !!mowBack.recurring_schedule_id);
  check("(b) one-time line stamped", !!aerateBack.recurring_schedule_id);
  check("(c) non-scheduled line NOT stamped", !materialBack.recurring_schedule_id);

  const { data: estBack } = await admin.from("estimates").select("status, converted_at").eq("id", est.id).single();
  check("(e) estimate status=converted", estBack.status === "converted");
  check("(e) converted_at set", !!estBack.converted_at);

  // 6. Cleanup.
  await admin.from("estimate_line_items").delete().eq("estimate_id", est.id);
  await admin.from("recurring_schedules").delete().in("id", schedIds);
  await admin.from("estimates").delete().eq("id", est.id);
  await admin.from("lawn_jobs").delete().eq("id", job.id);
  await admin.from("jobs").delete().eq("id", job.id);
  await admin.from("customers").delete().eq("id", cust.id);

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });