import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getMeIdentity } from "@/lib/tenant";
import EstimateDocument from "@/components/EstimateDocument";
import { summarizeLineSchedule, type ScheduleFrequency } from "@/lib/lawnEstimate";
import type { EstimateSnapshot } from "@/lib/sends";
import type { EstimatePricing } from "@/lib/money";

export const dynamic = "force-dynamic";

// Office-only: view the immutable send-time snapshot of an estimate (Issue 3).
// Reads the `estimate_sends` row by id (service role) + guards org. Renders the
// SAME EstimateDocument the customer saw at /q/{token}, from the archived JSON —
// so the office can prove exactly what was sent even if the live estimate was
// later revised. The `id` param is the estimate id (for the back link); the
// `sendId` param selects the archived send.
export default async function EstimateSnapshotPage({
  params,
}: {
  params: Promise<{ id: string; sendId: string }>;
}) {
  const { id, sendId } = await params;

  const me = await getMeIdentity();
  if (!me || (me.role !== "office" && me.role !== "admin" && !me.isSuperAdmin)) {
    notFound();
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: row } = await admin
    .from("estimate_sends")
    .select("id, estimate_id, organization_id, sent_at, sent_by, sent_via, recipient, snapshot")
    .eq("id", sendId)
    .maybeSingle();

  if (!row) notFound();
  // Cross-tenant backstop — the snapshot is org-scoped.
  const rowOrgId = (row.organization_id as string | null) ?? null;
  if (!me.isSuperAdmin && me.orgId !== rowOrgId) notFound();
  // The send must belong to the estimate in the URL (defensive — a stale link
  // to a different estimate's send under this estimate's path 404s).
  if ((row.estimate_id as string) !== id) notFound();

  const snap = row.snapshot as unknown as EstimateSnapshot;

  // Logo URL from the archived logo_path (public bucket — stable URL).
  const orgLogoUrl = snap.org.logo_path
    ? admin.storage.from("org-logos").getPublicUrl(snap.org.logo_path).data.publicUrl
    : null;

  const customerName = snap.customer?.name ?? "—";
  const jobName =
    snap.job?.name ?? snap.estimate.title ?? customerName;
  const projectAddress = snap.job?.address ?? snap.customer?.address ?? null;

  const pricing: EstimatePricing = {
    markupPct: snap.estimate.markup_pct,
    contingencyPct: snap.estimate.contingency_pct,
    taxPct: snap.estimate.tax_pct,
    depositPct: snap.estimate.deposit_pct,
    depositAmount: snap.estimate.deposit_amount,
  };

  const sentAt = (row.sent_at as string) ?? null;
  const via = (row.sent_via as string) ?? "email";
  const recipient = (row.recipient as string | null) ?? null;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <Link
          href={`/estimates/${id}`}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[70%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">Back to estimate</span>
        </Link>
        <h1 className="text-sm font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[55%]">
          Sent snapshot
        </h1>
        <div className="w-20" />
      </header>

      <div className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center text-xs text-amber-800">
          Archived snapshot — sent
          {sentAt ? ` ${new Date(sentAt).toLocaleString()}` : ""}
          {recipient ? ` to ${recipient}` : ""} via {via}. This is exactly what
          the customer received; the live estimate may have been revised since.
        </div>

        <EstimateDocument
          orgName={snap.org.name}
          orgAddress={snap.org.address}
          orgPhone={snap.org.phone}
          orgEmail={snap.org.email}
          orgLogoUrl={orgLogoUrl}
          customerName={customerName}
          jobName={jobName}
          status="sent"
          sentAt={snap.estimate.sent_at}
          approvedAt={snap.estimate.approved_at}
          rejectedAt={snap.estimate.rejected_at}
          validUntil={snap.estimate.valid_until}
          customerNotes={snap.estimate.customer_notes}
          estimateNumber={snap.estimate.estimate_number}
          projectAddress={projectAddress}
          pricing={pricing}
          showItemized={snap.estimate.show_itemized}
          exclusions={snap.estimate.exclusions}
          terms={snap.estimate.terms}
          paymentSchedule={snap.estimate.payment_schedule}
          items={snap.items.map((i) => ({
            id: String(i.position),
            description: i.description ?? "",
            quantity: i.quantity,
            unitPrice: i.unit_price,
            section: i.section,
            scheduleSummary: summarizeLineSchedule({
              schedule_frequency: i.schedule_frequency as ScheduleFrequency | null,
              schedule_interval_weeks: 0,
              schedule_days_of_week: i.schedule_days_of_week,
              schedule_day_of_month: i.schedule_day_of_month,
              schedule_start_date: i.schedule_start_date,
              schedule_end_date: i.schedule_end_date,
            }),
          }))}
        />
      </div>
    </div>
  );
}