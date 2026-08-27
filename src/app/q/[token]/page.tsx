import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import type { EstimatePricing } from "@/lib/money";
import EstimateDocument from "@/components/EstimateDocument";
import EstimateDecisionButtons from "./EstimateDecisionButtons";
import { summarizeLineSchedule, type ScheduleFrequency } from "@/lib/lawnEstimate";

export const dynamic = "force-dynamic";

// Public customer estimate view — no auth. The share_token in the URL is the
// only credential. Fetched via the service role (validating the token). Office
// hits Send → customer opens this link → sees the estimate + Approve/Reject →
// decides. The /q/{token} URL is preserved from the old quote flow so
// already-emailed links keep working; the token now lives on the estimates row
// (migrated with the same id).
//
// Selects only customer-safe columns (no cost_code_id, no internal_cost, no
// note, no viewed_at). The first open stamps viewed_at (fire-and-forget) so the
// office knows the customer looked.
export default async function PublicEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: estimate } = await admin
    .from("estimates")
    .select(
      "id, title, status, customer_notes, valid_until, sent_at, approved_at, rejected_at, organization_id, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, exclusions, terms, payment_schedule, show_itemized, jobs(name, address), customers(name, address)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!estimate) {
    notFound();
  }

  // Stamp viewed_at on first open (only if still null). Fire-and-forget —
  // don't block the render. Service role so it applies regardless of RLS.
  if (estimate.status === "sent") {
    void admin
      .from("estimates")
      .update({ viewed_at: new Date().toISOString() })
      .eq("share_token", token)
      .is("viewed_at", null);
  }

  // Customer-safe columns only — no cost_code_id, no internal_cost. The cadence
  // columns are customer-safe (the proposal is supposed to say "weekly mowing,
  // Mar–Oct"); recurring_schedule_id is an internal stamp and is NOT selected.
  // summarizeLineSchedule reads only frequency/days/day-of-month/start/end, so
  // interval_weeks is omitted too. Construction lines have null cadence → the
  // chip returns "" and never renders; EstimateDocument also gates on isLawn().
  const { data: lineItems } = await admin
    .from("estimate_line_items")
    .select(
      "id, description, quantity, unit_price, position, section, schedule_frequency, schedule_days_of_week, schedule_day_of_month, schedule_start_date, schedule_end_date"
    )
    .eq("estimate_id", estimate.id)
    .order("position");

  let orgName = "";
  let orgAddress: string | null = null;
  let orgPhone: string | null = null;
  let orgEmail: string | null = null;
  let orgLogoUrl: string | null = null;
  if (estimate.organization_id) {
    const { data: o } = await admin
      .from("organizations")
      .select("name, address, phone, email, logo_path")
      .eq("id", estimate.organization_id)
      .maybeSingle();
    if (o) {
      if (o.name) orgName = o.name;
      orgAddress = o.address;
      orgPhone = o.phone;
      orgEmail = o.email;
      // Public bucket → getPublicUrl builds a stable URL (no signed-URL
      // expiry), so the logo renders on this unauthenticated customer page.
      if (o.logo_path) {
        orgLogoUrl = admin.storage
          .from("org-logos")
          .getPublicUrl(o.logo_path).data.publicUrl;
      }
    }
  }

  const jobRow = estimate.jobs as unknown as { name: string; address: string | null } | null;
  const custRow = estimate.customers as unknown as { name: string; address: string | null } | null;
  const customerName = custRow?.name ?? "—";
  // Standalone (job-less) estimates: label the project with the title (or the
  // customer name) and use the customer's address as the project address.
  const jobName = jobRow?.name ?? (estimate.title as string | null) ?? customerName;
  const projectAddress = jobRow?.address ?? custRow?.address ?? null;

  const items = (lineItems ?? []).map((i) => ({
    id: i.id,
    description: i.description,
    quantity: Number(i.quantity),
    unitPrice: Number(i.unit_price),
    section: i.section ?? null,
    // Lawn cadence chip. "" for construction / unscheduled lines → no chip.
    scheduleSummary: summarizeLineSchedule({
      schedule_frequency: i.schedule_frequency as ScheduleFrequency | null,
      schedule_interval_weeks: 0,
      schedule_days_of_week: i.schedule_days_of_week ?? [],
      schedule_day_of_month: i.schedule_day_of_month ?? null,
      schedule_start_date: i.schedule_start_date ?? null,
      schedule_end_date: i.schedule_end_date ?? null,
    }),
  }));

  const pricing: EstimatePricing = {
    markupPct: Number(estimate.markup_pct) || 0,
    contingencyPct: Number(estimate.contingency_pct) || 0,
    taxPct: Number(estimate.tax_pct) || 0,
    depositPct: Number(estimate.deposit_pct) || 0,
    depositAmount: Number(estimate.deposit_amount) || 0,
  };

  // §1.3: an estimate past valid_until is no longer acceptable. The daily
  // /api/estimates/cron/expire cron flips status→expired, but on expiry day
  // (before the cron runs) status is still 'sent' — show the expired banner
  // regardless of status so the customer sees it BEFORE clicking Approve. The
  // decide route also rejects (410) as defense-in-depth. valid_until is a date
  // (YYYY-MM-DD); null means no expiry → never expired.
  const validUntil = (estimate as { valid_until?: string | null }).valid_until;
  const expired =
    !!validUntil && validUntil < new Date().toISOString().slice(0, 10);

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <EstimateDocument
        orgName={orgName}
        orgAddress={orgAddress}
        orgPhone={orgPhone}
        orgEmail={orgEmail}
        orgLogoUrl={orgLogoUrl}
        customerName={customerName}
        jobName={jobName}
        status={estimate.status}
        sentAt={estimate.sent_at}
        approvedAt={estimate.approved_at}
        rejectedAt={estimate.rejected_at}
        validUntil={estimate.valid_until}
        customerNotes={estimate.customer_notes}
        estimateNumber={estimate.estimate_number}
        projectAddress={projectAddress}
        pricing={pricing}
        showItemized={estimate.show_itemized ?? true}
        exclusions={estimate.exclusions}
        terms={estimate.terms}
        paymentSchedule={estimate.payment_schedule}
        items={items}
      />

      {/* §1.3: expired banner when past valid_until (covers the race before the
          cron flips status). Otherwise decision buttons only while awaiting the
          customer. */}
      {expired ? (
        <div className="max-w-md mx-auto px-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
            <p className="text-sm font-semibold text-amber-900">
              This estimate has expired.
            </p>
            <p className="text-xs text-amber-800 mt-1">
              Please contact us for a current quote.
            </p>
          </div>
        </div>
      ) : estimate.status === "sent" ? (
        <div className="max-w-md mx-auto px-4">
          <EstimateDecisionButtons token={token} />
        </div>
      ) : null}
    </div>
  );
}