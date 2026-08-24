// Lawn estimate → scheduled services (Track 3). Office-only, lawn-only. Spawns
// one recurring_schedules row per schedulable line item onto the estimate's
// (existing or newly created) lawn job, seeds visits, and flips the estimate to
// status='converted'. The customer approves first (existing approve-only path);
// this is the office's separate "Schedule approved services" action.
//
// Construction 403s here (defense-in-depth — construction line items carry no
// cadence, and the cadence UI is hidden on construction). The proxy can't
// prefix-block /api/estimates/[id]/convert without blocking the shared
// /api/estimates/* send + decide routes construction needs, so the in-route
// gate is the authority.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { OFFICE_OR_PM } from "@/lib/roles";
import { convertEstimateToSchedules, isSchedulable, type EstimateLineRow } from "@/lib/lawnEstimate";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getMe();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (me.appVariant !== "lawn")
    return NextResponse.json({ error: "Not available" }, { status: 403 });
  const role = me.hasProfile ? me.role : null;
  if (!role || !OFFICE_OR_PM.has(role as never))
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const { id } = await params;
  const supabase = await createClient();

  // Load the estimate + its customer (for naming a new job). organization_id
  // is the source of truth for the new job's org (handles super_admin w/ no
  // me.orgId). RLS session client — office reads its own estimates.
  const { data: est, error: estErr } = await supabase
    .from("estimates")
    .select("id, job_id, customer_id, status, organization_id, title, customers(name, address)")
    .eq("id", id)
    .maybeSingle();
  if (estErr) return NextResponse.json({ error: `Load failed: ${estErr.message}` }, { status: 500 });
  if (!est) return NextResponse.json({ error: "Estimate not found" }, { status: 404 });

  if (est.status === "converted")
    return NextResponse.json({ error: "Already converted" }, { status: 409 });
  if (est.status !== "approved")
    return NextResponse.json({ error: "Estimate must be approved first" }, { status: 409 });

  // Load line items with cadence + the conversion stamp.
  const { data: lineRows, error: lineErr } = await supabase
    .from("estimate_line_items")
    .select(
      "id, description, section, unit_price, quantity, schedule_frequency, schedule_interval_weeks, schedule_days_of_week, schedule_day_of_month, schedule_start_date, schedule_end_date, recurring_schedule_id"
    )
    .eq("estimate_id", id)
    .order("position");
  if (lineErr) return NextResponse.json({ error: `Lines load failed: ${lineErr.message}` }, { status: 500 });

  const lineItems = (lineRows ?? []) as unknown as EstimateLineRow[];
  if (!lineItems.some((l) => isSchedulable(l) && !l.recurring_schedule_id)) {
    return NextResponse.json({ error: "No schedulable line items on this estimate" }, { status: 400 });
  }

  // Resolve the lawn job: reuse the estimate's job_id if present (and it's a
  // lawn job), otherwise create a new lawn job + lawn_jobs profile — completing
  // the prospect pipeline estimates_no_job.sql anticipated.
  let jobId = est.job_id as string | null;
  let createdJob = false;

  if (jobId) {
    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .select("id, type")
      .eq("id", jobId)
      .maybeSingle();
    if (jobErr) return NextResponse.json({ error: `Job load failed: ${jobErr.message}` }, { status: 500 });
    if (!job) return NextResponse.json({ error: "Linked job not found" }, { status: 404 });
    if (job.type !== "lawn")
      return NextResponse.json({ error: "Linked job is not a lawn job" }, { status: 409 });
  } else {
    // Create a new lawn job from the estimate.
    if (!est.customer_id)
      return NextResponse.json({ error: "Link a customer before scheduling" }, { status: 400 });
    if (!est.organization_id)
      return NextResponse.json({ error: "Estimate has no organization" }, { status: 400 });

    const cust = est.customers as unknown as { name: string | null; address: string | null } | null;
    const custName = cust?.name ?? "Property";
    const custAddr = cust?.address ?? null;
    const { data: newJob, error: newJobErr } = await supabase
      .from("jobs")
      .insert({
        organization_id: est.organization_id,
        customer_id: est.customer_id,
        name: est.title?.trim() || `${custName} — Lawn`,
        address: custAddr,
        status: "scheduled",
        type: "lawn",
      })
      .select("id")
      .single();
    if (newJobErr || !newJob)
      return NextResponse.json({ error: `Job create failed: ${newJobErr?.message ?? "error"}` }, { status: 500 });
    jobId = newJob.id;
    createdJob = true;

    // 1:1 lawn_jobs profile (id IS the job id). Defaults — office fills
    // lot_sqft/pets/etc. on the schedule detail page later.
    const { error: profileErr } = await supabase.from("lawn_jobs").insert({
      id: jobId,
      organization_id: est.organization_id,
    });
    if (profileErr && profileErr.code !== "23505")
      return NextResponse.json({ error: `Lawn profile failed: ${profileErr.message}` }, { status: 500 });

    // Link the estimate back to the new job so a later re-open keeps the bond.
    await supabase.from("estimates").update({ job_id: jobId }).eq("id", id);
  }

  try {
    const { schedules } = await convertEstimateToSchedules(
      { estimateId: id, jobId: jobId as string, lineItems, userId: me.user.id },
      supabase
    );
    return NextResponse.json({ jobId: jobId as string, created: createdJob, schedules });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Conversion failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}