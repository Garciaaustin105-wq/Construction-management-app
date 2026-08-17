import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sendCustomerNotification } from "@/lib/customerNotifications";
import { isLawn } from "@/lib/variant";

// Morning-of customer reminders for today's lawn visits. Fires ~8 AM local
// (vercel.json "8 13 * * *" = 13:08 UTC ≈ 08:00 CDT/07:00 CST). For every visit
// due today that is still `pending`, sends the visit_reminder notification
// (templated, opt-in gated, both email+sms attempted) to the job's customer.
//
// Secured by CRON_SECRET (Vercel Cron sends `Authorization: Bearer <secret>`),
// runs with the service role (bypasses RLS) so it can read across orgs and log
// without a session. Mirrors /api/lawn/cron/generate. Idempotent enough for
// once-daily: a re-run the same day re-sends (acceptable; cron fires once).
// Construction orgs have no seeded templates unless an office enabled them, so
// this is a no-op there — harmless.

export const dynamic = "force-dynamic";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 401 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One shared database, two Vercel deploys: both schedule this cron (same
  // vercel.json). The construction deploy is the established cron owner; the
  // lawn deploy's scheduled invocation no-ops here to avoid double reminder
  // emails (each fire would send its own set). If ownership ever moves to the
  // lawn deploy, flip this gate.
  if (isLawn()) {
    return NextResponse.json({ ok: true, skipped: "construction owns cron" });
  }

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured (service role missing)" },
      { status: 500 }
    );
  }
  const admin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const today = todayISO();

  // Today's still-pending visits. (A visit already done/skipped before the
  // reminder fires needs no reminder.)
  const { data: visits } = await admin
    .from("lawn_visits")
    .select("id, job_id, organization_id, due_date")
    .eq("due_date", today)
    .eq("status", "pending");
  const visitRows = (visits as unknown as
    | Array<{
        id: string;
        job_id: string;
        organization_id: string;
        due_date: string;
      }>
    | null) ?? [];

  let processed = 0;
  let sent = 0;
  const errors: { visit_id: string; error: string }[] = [];

  for (const v of visitRows) {
    processed += 1;
    try {
      const { data: job } = await admin
        .from("jobs")
        .select("customer_id, name, address, organization_id")
        .eq("id", v.job_id)
        .maybeSingle();
      const j = job as unknown as
        | {
            customer_id: string | null;
            name: string | null;
            address: string | null;
            organization_id: string | null;
          }
        | null;
      const customerId = j?.customer_id;
      if (!customerId) continue; // no customer to notify

      const orgId = v.organization_id || j?.organization_id;
      if (!orgId) continue;

      const { data: org } = await admin
        .from("organizations")
        .select("name")
        .eq("id", orgId)
        .maybeSingle();
      const orgName = (org as unknown as { name: string | null } | null)?.name ?? null;

      const results = await sendCustomerNotification({
        supabase: admin,
        event: "visit_reminder",
        organizationId: orgId,
        visitId: v.id,
        customerId,
        customerName: null, // resolved inside the helper
        jobName: j?.name ?? null,
        address: j?.address ?? null,
        serviceDate: v.due_date,
        orgName,
      });
      if (results.some((r) => r.status === "sent")) sent += 1;
    } catch (e) {
      errors.push({
        visit_id: v.id,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    visits: processed,
    notified: sent,
    errors,
  });
}