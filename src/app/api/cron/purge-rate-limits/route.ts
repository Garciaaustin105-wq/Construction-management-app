import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";

// Daily purge of the shared `rate_limits` throttle table — closes the §7 audit
// gap: `purge_rate_limits()` existed but was never scheduled, so rate_limits
// grew without bound. The function (SECURITY DEFINER) deletes rows whose
// window_start is older than p_older_than_hours (default 24). Any window old
// enough to purge can never match a live check (check_rate_limit only counts
// rows inside the active window), so deleting them is safe and fully
// idempotent — a re-run or a double-fire (both deploys) just re-deletes zero.
//
// rate_limits is a GLOBAL throttle table (keys are IP/token buckets, not tenant
// rows), so one platform cron covers every org. Deploy ownership: one DB, two
// deploys, same vercel.json — the CONSTRUCTION deploy owns all platform-wide
// crons (see lawn/cron/remind, invoices/cron/remind, estimates/cron/expire);
// the lawn deploy no-ops.

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

  // 24h matches the function default — any window older than a day can never
  // be checked again (the longest window in use is 3600s = 1h), so 24h is a
  // generous, safe retention floor.
  const { data, error } = await admin.rpc("purge_rate_limits", {
    p_older_than_hours: 24,
  });

  if (error) {
    captureException(
      new Error(`cron/purge-rate-limits failed: ${error.message}`)
    );
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const purged = typeof data === "number" ? data : 0;
  return NextResponse.json({ ok: true, purged });
}