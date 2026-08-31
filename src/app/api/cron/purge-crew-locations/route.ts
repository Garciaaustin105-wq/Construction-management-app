import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";

// Daily purge of the `crew_locations` table — stores sparse GPS breadcrumbs (about
// one every 5 minutes) for lawn crew live tracking, retained 7 days, and it grows
// continuously while crews are tracked so it must be purged. The function
// (SECURITY DEFINER) deletes rows whose timestamp is older than p_older_than_days
// (default 7). Any location old enough to purge can never be relevant again, so
// deleting them is safe and fully idempotent — a re-run or a double-fire (both
// deploys) just re-deletes zero.
//
// Unlike rate_limits, crew_locations IS tenant-scoped (every row carries
// organization_id). One platform cron still covers every org, but for a
// different reason than the template it was adapted from: purge_crew_locations
// is SECURITY DEFINER and the cron calls it with the service role, so it sweeps
// by AGE across all tenants in one pass rather than needing a per-org run.
//
// Deploy ownership: one DB, two deploys, same vercel.json — the CONSTRUCTION
// deploy owns all platform-wide crons (see lawn/cron/remind,
// invoices/cron/remind, estimates/cron/expire); the lawn deploy no-ops. Note
// this purges LAWN tracking data from the CONSTRUCTION deploy, which looks odd
// but matches every other cron here: the gate is about which deploy runs the
// schedule, not which variant owns the data.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // Construction deploy owns platform-wide crons (one DB, two deploys).
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

  // 7 days matches the function default — any location older than 7 days can
  // never be relevant again, so 7 days is a safe retention floor.
  const { data, error } = await admin.rpc("purge_crew_locations", {
    p_older_than_days: 7,
  });

  if (error) {
    captureException(
      new Error(`cron/purge-crew-locations failed: ${error.message}`)
    );
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const purged = typeof data === "number" ? data : 0;
  return NextResponse.json({ ok: true, purged });
}
