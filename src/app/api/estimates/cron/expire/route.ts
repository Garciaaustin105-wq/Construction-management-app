import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";

// Daily estimate-expiry sweep — closes the margin-protection gap the audit
// flagged (§1.3): estimates.valid_until was decorative, so a customer could
// accept a six-month-old price and the app built the invoice at that price.
// This flips a `sent` estimate to `expired` once valid_until has passed. Once
// expired, neither the public /decide route nor the authed approve_estimate RPC
// can act (both guard on status='sent') — so the cron is the primary gate.
// The /decide route ALSO checks valid_until directly to close the race on
// expiry day before this cron runs.
//
// Idempotent: the status='sent' filter excludes rows already flipped, so a
// re-run or a double-fire (both deploys) is a no-op beyond the first. No dedup
// needed (unlike the invoice-remind cron, there's no per-row side effect).
//
// Deploy ownership: one DB, two deploys, same vercel.json. The CONSTRUCTION
// deploy owns all platform-wide crons (see lawn/cron/remind + the invoices
// remind cron); the lawn deploy no-ops. Estimates are platform-wide (both
// variants send them), so the construction sweep covers lawn orgs too.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  // Flip sent estimates whose valid_until is in the past. status='sent' is the
  // gate (draft/approved/converted/rejected/expired are left alone). A null
  // valid_until means "no expiry" — those stay sent indefinitely, by design.
  const today = todayISO();
  const { data, error } = await admin
    .from("estimates")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("status", "sent")
    .not("valid_until", "is", null)
    .lt("valid_until", today)
    .select("id");

  if (error) {
    captureException(
      new Error(`estimates/cron/expire failed: ${error.message}`)
    );
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const expired = ((data as { id: string }[] | null) ?? []).length;
  return NextResponse.json({ ok: true, expired });
}