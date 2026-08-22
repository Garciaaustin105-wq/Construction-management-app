import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDunningEmail } from "@/lib/ispSubscriptions";
import { isLawn } from "@/lib/variant";

export const dynamic = "force-dynamic";

// Daily ISP dunning sweep: suspend subscribers whose grace window has run out.
//
// THE DIVISION OF LABOUR (worth stating, because it's easy to put logic in the
// wrong half):
//
//   The WEBHOOK reacts to Stripe. It marks a subscriber past_due the moment a
//   payment fails, stamps grace_until = now + org.dunning_grace_days, and sends
//   the warning email. It never suspends anyone — at the moment a card is
//   declined, the customer is entitled to their grace period.
//
//   This CRON enforces the passage of time, which no webhook can. It is the
//   only thing that turns past_due into suspended, and it does so strictly on
//   grace_until having passed.
//
// Restoration is NOT handled here — that's `invoice.paid` on the webhook, which
// fires the moment money arrives rather than up to 24h later. A suspended
// customer who pays at 2am gets service back at 2am, not on the next sweep.
//
// Secured by CRON_SECRET (Vercel Cron sends `Authorization: Bearer <secret>`),
// runs with the service role so it can sweep across orgs without a session.
// Mirrors /api/lawn/cron/remind.
//
// IDEMPOTENT: the query only matches status = 'past_due', and each row is
// flipped to 'suspended' as it's processed, so a same-day re-run finds nothing
// and re-suspends (and re-emails) nobody.

async function runDunningSweep(request: Request) {
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

  // One shared database, two Vercel deploys, one vercel.json. The construction
  // deploy is the established cron owner; the lawn deploy's invocation no-ops
  // so nobody gets suspended twice or emailed twice. Same gate as the lawn
  // crons — if ownership moves, flip all of them together.
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

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // The partial index idx_isp_subscriptions_dunning covers exactly this shape.
  const { data: due, error } = await admin
    .from("isp_subscriptions")
    .select("id, organization_id, customer_id, grace_until")
    .eq("status", "past_due")
    .not("grace_until", "is", null)
    .lt("grace_until", nowIso);

  if (error) {
    return NextResponse.json(
      { error: "Could not read subscriptions due for suspension" },
      { status: 500 }
    );
  }

  const rows = due ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, suspended: 0, emailed: 0 });
  }

  // Org names for the email "from" line, fetched once rather than per row.
  const orgIds = [...new Set(rows.map((r) => r.organization_id as string))];
  const { data: orgs } = await admin
    .from("organizations")
    .select("id, name")
    .in("id", orgIds);
  const orgNames = new Map(
    (orgs ?? []).map((o) => [o.id as string, (o.name as string | null) ?? null])
  );

  let suspended = 0;
  let emailed = 0;
  const failures: string[] = [];

  for (const row of rows) {
    const id = row.id as string;

    // Suspend FIRST, email second. If the mailer is down we still want the
    // service cutoff applied — the alternative (email first, suspend on
    // success) leaves non-paying customers connected indefinitely whenever
    // Resend has a bad day. The DB trigger mirrors this onto
    // isp_customer_profiles.service_suspended.
    const { error: updateError } = await admin
      .from("isp_subscriptions")
      .update({ status: "suspended", suspended_at: nowIso })
      .eq("id", id)
      // Re-assert the precondition: if a payment landed between the SELECT and
      // now, invoice.paid has already flipped this row to active and this
      // update must not undo it.
      .eq("status", "past_due");

    if (updateError) {
      failures.push(id);
      continue;
    }
    suspended += 1;

    const ok = await sendDunningEmail({
      orgId: row.organization_id as string,
      orgName: orgNames.get(row.organization_id as string) ?? null,
      customerId: row.customer_id as string,
      kind: "suspended",
      graceUntil: null,
    });
    if (ok) emailed += 1;
  }

  return NextResponse.json({
    ok: true,
    suspended,
    emailed,
    failed: failures.length,
  });
}

export async function POST(request: Request) {
  return runDunningSweep(request);
}

// Vercel Cron issues GET for scheduled invocations; the existing lawn crons are
// POST-only and are triggered accordingly. Exporting both means this route
// works either way rather than silently 405-ing and never suspending anyone —
// a failure that would look exactly like "no one is past due."
export async function GET(request: Request) {
  return runDunningSweep(request);
}
