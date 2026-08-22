import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import CustomerBlueprints from "@/components/CustomerBlueprints";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import StatusBadge from "@/components/StatusBadge";
import CustomerEstimateActions from "@/app/estimates/[id]/CustomerEstimateActions";
import ClientChangeOrderActions from "@/components/ClientChangeOrderActions";
import CustomerMessages from "@/components/CustomerMessages";
import { formatMoney, computeTotal, computeEstimateTotals } from "@/lib/money";
import { isConstruction } from "@/lib/variant";
import { MapPin, FileText, Receipt, Sprout, FileDiff, MessagesSquare } from "lucide-react";
import Link from "next/link";

export default async function CustomerPortal() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("customer_id, full_name")
    .eq("id", me.user.id)
    .single();

  const customerId = profile?.customer_id;

  // Fan out the independent reads (jobs, estimates, invoices, change orders) in
  // parallel. Estimates are fetched across sent/approved/rejected so the summary
  // can total signed (approved) work and the pending list can filter to 'sent'.
  const [jobsRes, estimatesRes, invoicesRes, lawnJobsRes, changeOrdersRes] =
    await Promise.all([
      // Construction jobs only — lawn jobs live in the Lawn section below.
      supabase
        .from("jobs")
        .select("id, name, address, description, status, scheduled_start, scheduled_end")
        .eq("type", "construction")
        .order("created_at", { ascending: false }),
      customerId
        ? supabase
            .from("estimates")
            .select(
              "id, status, created_at, sent_at, title, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, requires_signature, jobs(name), estimate_line_items(quantity, unit_price)"
            )
            .eq("customer_id", customerId)
            .in("status", ["sent", "approved", "rejected"])
            .order("sent_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      customerId
        ? supabase
            .from("invoices")
            .select(
              "id, status, paid_at, created_at, amount_paid, jobs(name), invoice_line_items(quantity, unit_price)"
            )
            .eq("customer_id", customerId)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      // Lawn jobs (RLS restricts to the customer's own) → Lawn section below.
      customerId
        ? supabase
            .from("jobs")
            .select("id, name, address")
            .eq("type", "lawn")
            .order("name")
        : Promise.resolve({ data: [] }),
      // Construction change orders awaiting this customer's approval. RLS
      // (portal_messages.sql "Customer read own change orders") scopes to this
      // customer's jobs + status 'sent'/'approved'/'rejected'; we filter to
      // 'sent' for the awaiting-action list. Degrades to empty until that SQL
      // is run.
      customerId && isConstruction()
        ? supabase
            .from("change_orders")
            .select("id, co_number, title, amount, is_credit, jobs(name)")
            .eq("status", "sent")
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);

  const jobs = jobsRes.data;
  const allEstimates = estimatesRes.data;
  const invoices = invoicesRes.data;
  const pendingChangeOrders = (changeOrdersRes.data ?? []) as unknown as {
    id: string;
    co_number: string | null;
    title: string;
    amount: number | string | null;
    is_credit: boolean | null;
    jobs: { name: string } | null;
  }[];

  // ── Lawn section ─────────────────────────────────────────────────────────
  // Pull the customer's lawn visits (upcoming pending + recently completed)
  // so the portal surfaces recurring service independently of the construction
  // Projects list. RLS admits the owning customer on lawn_visits (same policy
  // family as schedule_events), so no customer_id filter is needed.
  const lawnJobs = (lawnJobsRes.data ?? []) as {
    id: string;
    name: string;
    address: string | null;
  }[];
  const lawnJobIds = lawnJobs.map((j) => j.id);
  const lawnVisitsRes =
    lawnJobIds.length > 0
      ? await supabase
          .from("lawn_visits")
          .select(
            "id, due_date, status, completed_at, jobs(name, address), recurring_schedules(service_type)"
          )
          .in("job_id", lawnJobIds)
          .order("due_date", { ascending: false })
          .limit(60)
      : { data: [] as never[] };
  type LawnVisitRow = {
    id: string;
    due_date: string;
    status: string;
    completed_at: string | null;
    jobs: { name: string; address: string | null } | null;
    recurring_schedules: { service_type: string | null } | null;
  };
  const lawnVisits = (lawnVisitsRes.data ?? []) as unknown as LawnVisitRow[];
  const today = new Date().toISOString().slice(0, 10);
  const upcomingVisits = lawnVisits
    .filter((v) => v.status === "pending" && v.due_date >= today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 6);
  const recentDone = lawnVisits.filter((v) => v.status === "done").slice(0, 4);

  const jobsWithFiles = await Promise.all(
    (jobs ?? []).map(async (job) => {
      const [{ data: photos }, { data: blueprints }] = await Promise.all([
        supabase
          .from("photos")
          .select("id, storage_path, caption, created_at")
          .eq("job_id", job.id)
          .order("created_at", { ascending: false })
          .limit(6),
        supabase
          .from("blueprints")
          .select("id, storage_path, filename, caption, created_at")
          .eq("job_id", job.id)
          .order("created_at", { ascending: false }),
      ]);
      return { ...job, photos: photos ?? [], blueprints: blueprints ?? [] };
    })
  );

  const estimateRows = (allEstimates ?? []).map((q) => {
    const items =
      (q.estimate_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    const totals = computeEstimateTotals(items, {
      markupPct: Number(q.markup_pct) || 0,
      contingencyPct: Number(q.contingency_pct) || 0,
      taxPct: Number(q.tax_pct) || 0,
      depositPct: Number(q.deposit_pct) || 0,
      depositAmount: Number(q.deposit_amount) || 0,
    });
    const hasPricing =
      totals.markupAmount > 0 ||
      totals.contingencyAmount > 0 ||
      totals.taxAmount > 0 ||
      totals.depositAmount > 0;
    return {
      id: q.id,
      status: q.status,
      requiresSignature: !!(q as { requires_signature?: boolean | null }).requires_signature,
      estimateNumber: (q as { estimate_number?: string | null }).estimate_number ?? null,
      // Standalone (job-less) estimates fall back to the title.
      jobName:
        (q.jobs as unknown as { name: string } | null)?.name ??
        (q as { title?: string | null }).title ??
        "—",
      sentAt: q.sent_at,
      total: hasPricing ? totals.grandTotal : computeTotal(items),
    };
  });

  // Pending estimates = sent (awaiting this customer's decision). Approved ones
  // feed the "Contracted" KPI below.
  const pendingEstimateRows = estimateRows.filter((e) => e.status === "sent");

  const invoiceRows = (invoices ?? []).map((inv) => {
    const items =
      (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    const invTotal = computeTotal(items);
    const amountPaid = Number((inv as { amount_paid?: number | null }).amount_paid ?? 0) || 0;
    // Unpaid invoices show the balance due (grand total − deposit) so the
    // customer sees what they still owe after the deposit was applied.
    const owed =
      inv.status === "sent" && amountPaid > 0
        ? Math.max(0, invTotal - amountPaid)
        : invTotal;
    return {
      id: inv.id,
      status: inv.status,
      paidAt: inv.paid_at,
      createdAt: inv.created_at,
      jobName: (inv.jobs as unknown as { name: string } | null)?.name ?? "—",
      total: owed,
      depositApplied: inv.status === "sent" && amountPaid > 0,
    };
  });

  const unpaidInvoices = invoiceRows.filter((i) => i.status === "sent");

  // ── Financial summary KPI strip ──────────────────────────────────────────
  // Contracted = Σ approved estimate grand totals (signed work). Outstanding =
  // Σ balances on sent (unpaid) invoices. Paid = Σ paid-invoice totals. All from
  // RLS-scoped rows already fetched (same customer-own policies), so no new SQL.
  const contractedTotal = estimateRows
    .filter((e) => e.status === "approved")
    .reduce((sum, e) => sum + e.total, 0);
  const paidTotal = invoiceRows
    .filter((i) => i.status === "paid")
    .reduce((sum, i) => sum + i.total, 0);
  const outstandingTotal = unpaidInvoices.reduce((sum, i) => sum + i.total, 0);
  const hasSummary = contractedTotal > 0 || paidTotal > 0 || outstandingTotal > 0;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title={profile?.full_name ?? "Project Portal"}
        subtitle={me.user.email ?? ""}
        showSignOut
      />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <ClientPullToRefresh>
          {/* Financial summary */}
          {hasSummary && (
            <section>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Contracted</p>
                  <p className="text-base font-bold text-gray-900 mt-1">
                    {formatMoney(contractedTotal)}
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Outstanding</p>
                  <p className="text-base font-bold text-amber-600 mt-1">
                    {formatMoney(outstandingTotal)}
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 shadow-sm">
                  <p className="text-[10px] uppercase tracking-wide text-gray-500">Paid</p>
                  <p className="text-base font-bold text-green-600 mt-1">
                    {formatMoney(paidTotal)}
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Pending estimate approvals */}
          {pendingEstimateRows.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                <FileText className="w-4 h-4" />
                Estimates awaiting your approval
              </h2>
              <div className="space-y-3">
                {pendingEstimateRows.map((q) =>
                  // A proposal (requires_signature) routes to the authed
                  // e-sign page instead of the inline one-click approve — the
                  // customer must type their name + draw a signature, which the
                  // sign page owns. Plain estimates keep the inline actions.
                  q.requiresSignature ? (
                    <div
                      key={q.id}
                      className="bg-amber-50 border border-amber-200 rounded-lg p-3"
                    >
                      <Link
                        href={`/customer/estimates/${q.id}/sign`}
                        className="block active:bg-amber-100 -m-3 p-3"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-900 truncate">
                              {q.jobName}
                              <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-amber-700 align-middle">
                                Proposal
                              </span>
                            </p>
                            <p className="text-xs text-amber-800 mt-0.5">
                              {q.estimateNumber ? `#${q.estimateNumber} · ` : ""}
                              Sent {new Date(q.sentAt).toLocaleDateString()}
                            </p>
                          </div>
                          <span className="text-base font-bold text-gray-900">
                            {formatMoney(q.total)}
                          </span>
                        </div>
                        <p className="text-xs text-amber-900 mt-2 font-medium">
                          Tap to review &amp; sign →
                        </p>
                      </Link>
                    </div>
                  ) : (
                    <div
                      key={q.id}
                      className="bg-amber-50 border border-amber-200 rounded-lg p-3"
                    >
                      <Link
                        href={`/estimates/${q.id}`}
                        className="block active:bg-amber-100 -m-3 p-3"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-900 truncate">
                              {q.jobName}
                            </p>
                            <p className="text-xs text-amber-800 mt-0.5">
                              {q.estimateNumber ? `#${q.estimateNumber} · ` : ""}
                              Sent {new Date(q.sentAt).toLocaleDateString()}
                            </p>
                          </div>
                          <span className="text-base font-bold text-gray-900">
                            {formatMoney(q.total)}
                          </span>
                        </div>
                        <p className="text-xs text-amber-900 mt-2">
                          Tap to review the line items →
                        </p>
                      </Link>
                      <div className="mt-2">
                        <CustomerEstimateActions estimateId={q.id} />
                      </div>
                    </div>
                  )
                )}
              </div>
            </section>
          )}

          {/* Change orders awaiting approval (construction) */}
          {isConstruction() && pendingChangeOrders.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                <FileDiff className="w-4 h-4" />
                Change Orders awaiting your approval
              </h2>
              <div className="space-y-3">
                {pendingChangeOrders.map((co) => {
                  const amt = Number(co.amount ?? 0) || 0;
                  return (
                    <div
                      key={co.id}
                      className="bg-orange-50 border border-orange-200 rounded-lg p-3"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-gray-900 truncate">
                            {co.title || "Change order"}
                          </p>
                          <p className="text-xs text-orange-800 mt-0.5">
                            {co.co_number ? `#${co.co_number} · ` : ""}
                            {co.jobs?.name ?? "—"}
                          </p>
                        </div>
                        <span className="text-base font-bold text-gray-900 whitespace-nowrap">
                          {co.is_credit ? "-" : ""}
                          {formatMoney(amt)}
                        </span>
                      </div>
                      <div className="mt-2">
                        <ClientChangeOrderActions coId={co.id} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Unpaid invoices */}
          {unpaidInvoices.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                <Receipt className="w-4 h-4" />
                Unpaid Invoices
              </h2>
              <div className="space-y-2">
                {unpaidInvoices.map((inv) => (
                  <Link
                    key={inv.id}
                    href={`/invoices/${inv.id}`}
                    className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 truncate">
                          {inv.jobName}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Issued {new Date(inv.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <StatusBadge status={inv.status} />
                        <span className="text-sm font-bold text-gray-900">
                          {formatMoney(inv.total)}
                        </span>
                        {inv.depositApplied && (
                          <span className="text-[10px] text-gray-400">
                            after deposit
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Paid invoices (collapsed-feel) */}
          {invoiceRows.length > unpaidInvoices.length && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
                Invoice History
              </h2>
              <div className="space-y-2">
                {invoiceRows
                  .filter((i) => i.status !== "sent")
                  .map((inv) => (
                    <Link
                      key={inv.id}
                      href={`/invoices/${inv.id}`}
                      className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-gray-700 truncate">
                            {inv.jobName}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {inv.paidAt
                              ? `Paid ${new Date(inv.paidAt).toLocaleDateString()}`
                              : `Void ${new Date(inv.createdAt).toLocaleDateString()}`}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <StatusBadge status={inv.status} />
                          <span className="text-sm text-gray-700">
                            {formatMoney(inv.total)}
                          </span>
                        </div>
                      </div>
                    </Link>
                  ))}
              </div>
            </section>
          )}

          {/* Lawn service — upcoming visits + recent completions */}
          {(upcomingVisits.length > 0 || recentDone.length > 0) && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                <Sprout className="w-4 h-4 text-green-600" />
                Lawn Service
              </h2>
              <div className="space-y-2">
                {upcomingVisits.map((v) => (
                  <div key={v.id} className="bg-white rounded-lg p-3 shadow-sm">
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">
                          {v.jobs?.name ?? "Lawn visit"}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {v.recurring_schedules?.service_type ?? "Service"} ·{" "}
                          {new Date(v.due_date).toLocaleDateString()}
                        </p>
                      </div>
                      <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-1 rounded-full whitespace-nowrap">
                        Scheduled
                      </span>
                    </div>
                    {v.jobs?.address && (
                      <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        <span>{v.jobs.address}</span>
                      </p>
                    )}
                  </div>
                ))}
                {recentDone.map((v) => (
                  <div
                    key={v.id}
                    className="bg-white rounded-lg p-3 shadow-sm"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-700 truncate">
                          {v.jobs?.name ?? "Lawn visit"}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {v.recurring_schedules?.service_type ?? "Service"} ·{" "}
                          {v.completed_at
                            ? `Completed ${new Date(v.completed_at).toLocaleDateString()}`
                            : new Date(v.due_date).toLocaleDateString()}
                        </p>
                      </div>
                      <span className="text-xs font-medium text-gray-400 whitespace-nowrap">
                        Done
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Messages with the office */}
          {customerId && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                <MessagesSquare className="w-4 h-4" />
                Messages
              </h2>
              <CustomerMessages customerId={customerId} />
            </section>
          )}

          {/* Jobs */}
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
              Projects
            </h2>
            {jobsWithFiles.length === 0 && (
              <div className="bg-white rounded-lg">
                <EmptyState
                  icon={EmptyIcons.Briefcase}
                  title="No projects yet"
                  description="Once the office links you to a project, you'll see job status, photos, and blueprints here."
                />
              </div>
            )}

            {jobsWithFiles.map((job) => (
              <article
                key={job.id}
                className="bg-white rounded-lg shadow-sm overflow-hidden mb-3"
              >
                <div className="p-4">
                  <div className="flex justify-between items-start mb-1">
                    <h2 className="text-base font-semibold text-gray-900">
                      {job.name}
                    </h2>
                    <StatusBadge status={job.status} />
                  </div>
                  {job.address && (
                    <p className="text-sm text-gray-600 flex items-center gap-1">
                      <MapPin className="w-4 h-4 flex-shrink-0" />
                      <span>{job.address}</span>
                    </p>
                  )}
                  {job.description && (
                    <p className="text-sm text-gray-600 mt-1">{job.description}</p>
                  )}
                  {(job.scheduled_start || job.scheduled_end) && (
                    <p className="text-xs text-gray-500 mt-1">
                      {job.scheduled_start} → {job.scheduled_end}
                    </p>
                  )}
                </div>

                {job.blueprints.length > 0 && (
                  <CustomerBlueprints blueprints={job.blueprints} />
                )}

                {job.photos.length > 0 && (
                  <div className="border-t border-gray-100 p-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                      Latest Photos
                    </p>
                    <SignedPhotoGrid photos={job.photos} />
                  </div>
                )}
              </article>
            ))}
          </section>
        </ClientPullToRefresh>
      </main>
    </div>
  );
}