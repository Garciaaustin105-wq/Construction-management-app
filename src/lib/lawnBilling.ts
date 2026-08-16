import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverInvoice, publicBaseUrl } from "@/lib/invoiceSend";

// Monthly lawn cycle billing. Shared by the on-demand office route (user
// session, RLS-enforced) and the nightly cron (service role, RLS bypassed) —
// both pass a supabase client in, so the same logic runs under either.
//
// Flow per customer (claim-then-line, race-safe):
//   1. Fetch done visits with invoice_id IS NULL (jobs + recurring_schedules).
//   2. Group by customer_id (visits without a customer are skipped — can't bill).
//   3. For each group: create one invoice (status 'sent', due +30d), then
//      UPDATE lawn_visits SET invoice_id = X WHERE id IN (...) AND invoice_id IS
//      NULL — the .select() returns exactly the rows THIS run claimed (a
//      concurrent run that already claimed them gets them excluded). Lines are
//      built ONLY from claimed rows, so no visit is ever billed twice. If a run
//      claims zero rows (a concurrent run took them all), the empty invoice is
//      voided.
//
// One line per visit: description "<service> — <due_date>" (prefixed with the
// job name when the customer has >1 distinct job in the run), quantity 1,
// unit_price = recurring_schedules.price_per_visit.

export type CycleBillingResult = {
  customers: number;
  invoicesCreated: number;
  visitsBilled: number;
  skippedNoCustomer: number;
  invoicesSent: number;
  details: { customer: string | null; invoiceId: string; visits: number }[];
};

type UnbilledVisit = {
  id: string;
  due_date: string;
  job_id: string;
  jobs: {
    id: string;
    name: string;
    customer_id: string | null;
  } | null;
  recurring_schedules: {
    service_type: string | null;
    price_per_visit: number;
  } | null;
};

function plus30DaysISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

export async function runCycleBilling(
  supabase: SupabaseClient
): Promise<CycleBillingResult> {
  const { data: rows } = await supabase
    .from("lawn_visits")
    .select(
      "id, due_date, job_id, jobs(id, name, customer_id), recurring_schedules(service_type, price_per_visit)"
    )
    .eq("status", "done")
    .is("invoice_id", null)
    .order("due_date", { ascending: true });
  const visits = (rows as unknown as UnbilledVisit[] | null) ?? [];

  // Group by customer_id; visits with no customer can't be billed.
  const byCustomer = new Map<string, UnbilledVisit[]>();
  let skippedNoCustomer = 0;
  for (const v of visits) {
    const cid = v.jobs?.customer_id ?? null;
    if (!cid) {
      skippedNoCustomer += 1;
      continue;
    }
    const arr = byCustomer.get(cid) ?? [];
    arr.push(v);
    byCustomer.set(cid, arr);
  }

  const dueDate = plus30DaysISO();
  const details: CycleBillingResult["details"] = [];
  let invoicesCreated = 0;
  let visitsBilled = 0;
  let invoicesSent = 0;

  for (const [customerId, group] of byCustomer) {
    // job_id on the invoice: MUST be non-null — the trg_invoices_org trigger
    // (set_org_from_job_or_estimate) derives organization_id from job_id (else
    // estimate_id) and RAISES when both are null. So always anchor to the
    // customer's first job; line descriptions carry each job's name so a
    // multi-property invoice stays clear. (For the common single-property
    // customer this is exactly their job.)
    const distinctJobs = new Set(group.map((v) => v.job_id));
    const invoiceJobId = group[0].job_id;
    const multiJob = distinctJobs.size > 1;
    const visitIds = group.map((v) => v.id);

    // 1. Create the invoice.
    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .insert({
        estimate_id: null,
        job_id: invoiceJobId,
        customer_id: customerId,
        status: "sent",
        due_date: dueDate,
      })
      .select("id")
      .single();
    if (invErr || !inv) continue;
    const invoiceId = (inv as { id: string }).id;

    // 2. Claim the visits (atomic): only rows still done AND unbilled are
    //    updated (a visit reopened to pending between fetch and claim must not be
    //    billed), and .select() returns exactly those rows.
    const { data: claimedRows } = await supabase
      .from("lawn_visits")
      .update({ invoice_id: invoiceId })
      .in("id", visitIds)
      .eq("status", "done")
      .is("invoice_id", null)
      .select(
        "id, due_date, jobs(name), recurring_schedules(service_type, price_per_visit)"
      );
    const claimed = (claimedRows as unknown as UnbilledVisit[] | null) ?? [];

    if (claimed.length === 0) {
      // A concurrent run claimed them all — void the empty invoice (no visits
      // point at it, so none are orphaned).
      await supabase.from("invoices").update({ status: "void" }).eq("id", invoiceId);
      continue;
    }

    // 3. Build one line per claimed visit.
    const lineInserts = claimed.map((v, idx) => {
      const service = v.recurring_schedules?.service_type ?? "Lawn service";
      const jobName = v.jobs?.name ?? null;
      const description = multiJob && jobName
        ? `${jobName}: ${service} — ${v.due_date}`
        : `${service} — ${v.due_date}`;
      return {
        invoice_id: invoiceId,
        description,
        quantity: 1,
        unit_price: Number(v.recurring_schedules?.price_per_visit ?? 0),
        position: idx,
      };
    });
    const { error: lineErr } = await supabase
      .from("invoice_line_items")
      .insert(lineInserts);
    if (lineErr) {
      // Lines failed after the claim committed — UNCLAIM the visits (back to
      // invoice_id null so they're re-billable next run) and void the now-empty
      // invoice so the customer never sees a $0 'sent' bill.
      await supabase
        .from("lawn_visits")
        .update({ invoice_id: null })
        .eq("invoice_id", invoiceId);
      await supabase.from("invoices").update({ status: "void" }).eq("id", invoiceId);
      continue;
    }

    // Auto-deliver the cycle invoice to the customer (whichever channel is on
    // file). Best-effort + non-fatal: a not-yet-configured Resend/Twilio or a
    // missing contact records a warning but never voids the invoice — the
    // billing already succeeded, so the customer simply owes it (re-sendable
    // manually from the invoice detail page once a channel is configured).
    try {
      const delivered = await deliverInvoice(invoiceId, { origin: publicBaseUrl() });
      if (delivered.delivered) invoicesSent += 1;
    } catch {
      // Swallow — delivery must not roll back a successfully billed invoice.
    }

    invoicesCreated += 1;
    visitsBilled += claimed.length;
    details.push({ customer: customerId, invoiceId, visits: claimed.length });
  }

  return {
    customers: byCustomer.size,
    invoicesCreated,
    visitsBilled,
    skippedNoCustomer,
    invoicesSent,
    details,
  };
}