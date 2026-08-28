import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { chargeInvoiceOffSession } from "@/lib/invoicePay";

// Daily retry for DECLINED autopay charges. When cycle billing (bill-cycle cron →
// chargeInvoiceOffSession) fails a card off-session, it stamps the invoice with
// autopay_attempts / autopay_next_retry_at / autopay_last_error and notifies the
// office. This cron re-attempts those charges every 3 days, up to 3 total attempts
// (the cap lives in invoicePay.ts), then gives up and leaves the invoice 'sent' —
// the customer keeps the Pay button and the office keeps the decline notification.
//
// Only invoices with a RECORDED decline are picked up (autopay_attempts > 0) —
// never a first charge of an invoice the office sent manually. Every charge here
// goes through chargeInvoiceOffSession, so the consent gate (autopay_enabled),
// saved-card check, balance recompute, and Connect direct-charge invariants are
// enforced in one place. A success marks the invoice paid inline; the webhook no-ops.
//
// Same deployment contract as every platform cron: CRON_SECRET bearer auth, the
// construction-deploy ownership gate (one DB, two deploys), service role,
// 60s ceiling.

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
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const now = new Date().toISOString();
  const { data: due, error } = await admin
    .from("invoices")
    .select("id")
    .eq("status", "sent")
    .gt("autopay_attempts", 0)
    .lt("autopay_attempts", 3)
    .not("autopay_next_retry_at", "is", null)
    .lte("autopay_next_retry_at", now)
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: { invoiceId: string; charged: boolean; reason?: string }[] = [];
  for (const inv of due ?? []) {
    try {
      const outcome = await chargeInvoiceOffSession({ invoiceId: inv.id });
      results.push({ invoiceId: inv.id, ...outcome });
    } catch (err) {
      // Never let one bad invoice kill the sweep — chargeInvoiceOffSession is
      // already non-throwing by design; this is belt-and-suspenders.
      results.push({
        invoiceId: inv.id,
        charged: false,
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  const retried = results.length;
  const recovered = results.filter((r) => r.charged).length;
  return NextResponse.json({ ok: true, due: due?.length ?? 0, retried, recovered, results });
}