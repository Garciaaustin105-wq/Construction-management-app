import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";
import { deliverInvoice } from "@/lib/invoiceSend";

// Daily overdue-invoice reminders — closes the money loop the audit flagged
// (§1.1): the app already KNEW which invoices were overdue (the /admin/insights
// Overdue A/R tile) but did nothing with it. This cron finds invoices that are
// `sent` (not paid/void), past due_date, with a positive balance, and re-sends
// them via the existing deliverInvoice path — at most once every
// REMINDER_INTERVAL_DAYS (notification_log dedup, event='invoice_reminder').
//
// Mirrors /api/lawn/cron/remind: CRON_SECRET bearer auth, service role, the
// construction-deploy ownership gate, bounded concurrency, Sentry failure
// visibility, idempotent-enough for once-daily.
//
// Deploy ownership: ONE database, TWO deploys (construction + lawn), same
// vercel.json. The construction deploy is the cron owner (see lawn/cron/remind
// — every platform cron lives there). The lawn deploy's invocation no-ops to
// avoid double-send. Lawn orgs' invoices ARE covered: the construction cron
// sweeps every org in the shared DB, lawn or construction.
//
// v1 scope: re-sends the existing invoice email (not a dedicated overdue
// template) and uses a flat 7-day re-remind cadence. A per-org dunning schedule
// (3/7/14-day escalating) and an "OVERDUE" email template are follow-ups.

export const dynamic = "force-dynamic";
// Vercel default 10s is too short for a platform-wide sweep. Bump to the Hobby
// ceiling (60s); the per-invoice work is concurrency-bounded so this is
// headroom, not the fix. Raise to 300 on Pro.
export const maxDuration = 60;

// Re-remind at most every N days. First reminder fires the first run after
// due_date passes; later reminders are spaced N days apart.
const REMINDER_INTERVAL_DAYS = 7;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type OverdueInvoice = {
  id: string;
  organization_id: string;
  due_date: string | null;
  sent_at: string | null;
};

type InvoiceWithLines = OverdueInvoice & {
  invoice_line_items: { quantity: number; unit_price: number }[] | null;
};

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

  const today = todayISO();

  // Overdue (due_date < today), still-open (`sent`) invoices with their line
  // items. Only 'sent' invoices are overdue — a 'draft' (see
  // invoices_draft_status.sql) has not been issued to the customer yet, so it
  // is intentionally excluded: the office owns sending a draft (the §1.2 draft
  // gate), and a draft that failed delivery is a config issue the office
  // resolves by sending, not something a reminder cron auto-sends. The sent_at
  // check below decides first-send vs reminder for the 'sent' rows that are
  // here.
  const { data: rows, error: qErr } = await admin
    .from("invoices")
    .select(
      "id, organization_id, due_date, sent_at, amount_paid, invoice_line_items(quantity, unit_price)"
    )
    .eq("status", "sent")
    .lt("due_date", today);
  if (qErr) {
    captureException(
      new Error(`invoice/cron/remind query failed: ${qErr.message}`)
    );
    return NextResponse.json({ ok: false, error: qErr.message }, { status: 500 });
  }

  // Keep only invoices with a positive balance due (total - amount_paid > 0).
  // Fully-paid or void invoices never get a reminder.
  const all = (rows as unknown as InvoiceWithLines[] | null) ?? [];
  const overdue: OverdueInvoice[] = all
    .map((r) => {
      const total =
        (r.invoice_line_items ?? []).reduce(
          (sum, li) => sum + Number(li.quantity) * Number(li.unit_price),
          0
        ) || 0;
      const balance = total - Number((r as { amount_paid?: number }).amount_paid ?? 0);
      return { row: r, balance };
    })
    .filter((x) => x.balance > 0.005)
    .map((x) => ({
      id: x.row.id,
      organization_id: x.row.organization_id,
      due_date: x.row.due_date,
      sent_at: x.row.sent_at,
    }));

  if (overdue.length === 0) {
    return NextResponse.json({ ok: true, overdue: 0, reminded: 0 });
  }

  // Dedup: an invoice_reminder 'sent' log row inside the last
  // REMINDER_INTERVAL_DAYS means it was nudged recently — skip. This is the
  // resume cursor: a re-run after a timeout only sends the not-yet-reminded.
  const allIds = overdue.map((r) => r.id);
  const since = new Date(
    Date.now() - REMINDER_INTERVAL_DAYS * 86_400_000
  ).toISOString();
  const { data: logRows } = await admin
    .from("notification_log")
    .select("entity_id")
    .eq("event", "invoice_reminder")
    .eq("status", "sent")
    .in("entity_id", allIds)
    .gte("created_at", since);
  const recentlyReminded = new Set<string>();
  for (const r of (logRows ?? []) as { entity_id: string }[]) {
    recentlyReminded.add(r.entity_id);
  }
  const candidates = overdue.filter((r) => !recentlyReminded.has(r.id));

  let processed = 0;
  let reminded = 0;
  const errors: { invoice_id: string; error: string }[] = [];

  // Bound email concurrency so a busy day doesn't blow the mail provider rate
  // limit. Each chunk awaits allSettled — one rejection never kills the rest.
  const CHUNK = 8;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const slice = candidates.slice(i, i + CHUNK);
    const outcomes = await Promise.allSettled(
      slice.map(async (inv) => {
        processed += 1;
        // sent_at null = never actually delivered → this is the first send,
        // let deliverInvoice stamp sent_at. Otherwise preserve the original
        // send date (skipSentAtStamp) so the aging clock doesn't reset.
        const result = await deliverInvoice(inv.id, {
          skipSentAtStamp: !!inv.sent_at,
        });
        if (!result.delivered) return;
        reminded += 1;
        // Log one 'sent' row per delivered channel so the dedup window above
        // suppresses re-reminders for REMINDER_INTERVAL_DAYS.
        const inserts = result.sentVia.map((channel) => ({
          organization_id: inv.organization_id,
          event: "invoice_reminder",
          channel,
          to_contact:
            channel === "email"
              ? result.sentTo.email ?? null
              : result.sentTo.phone ?? null,
          entity_type: "invoice",
          entity_id: inv.id,
          status: "sent",
        }));
        if (inserts.length > 0) {
          await admin.from("notification_log").insert(inserts);
        }
      })
    );
    slice.forEach((inv, idx) => {
      const r = outcomes[idx];
      if (r.status === "rejected") {
        errors.push({
          invoice_id: inv.id,
          error: r.reason instanceof Error ? r.reason.message : "unknown",
        });
      }
    });
  }

  // FAILURE VISIBILITY — a run where most reminders silently dropped must NOT
  // look like a clean one to Vercel Cron / Sentry. Mirrors lawn/cron/remind.
  if (errors.length > 0) {
    captureException(
      new Error(
        `invoice/cron/remind: ${errors.length}/${processed} reminders failed`
      ),
      {
        extra: {
          processed,
          reminded,
          failed: errors.length,
          sample: errors.slice(0, 10),
        },
      }
    );
  }

  const allFailed = processed > 0 && errors.length === processed;
  return NextResponse.json(
    {
      ok: errors.length === 0,
      overdue: overdue.length,
      reminded,
      errors,
    },
    { status: allFailed ? 500 : 200 }
  );
}