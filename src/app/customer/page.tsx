import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import CustomerBlueprints from "@/components/CustomerBlueprints";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import StatusBadge from "@/components/StatusBadge";
import { formatMoney, computeTotal } from "@/lib/money";
import { MapPin, FileText, Receipt } from "lucide-react";
import Link from "next/link";

export default async function CustomerPortal() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("customer_id, full_name, role")
    .eq("id", user.id)
    .single();

  const customerId = profile?.customer_id;

  // Fan out the independent reads (jobs, pending quotes, invoices) in parallel.
  const [jobsRes, quotesRes, invoicesRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, name, address, description, status, scheduled_start, scheduled_end")
      .order("created_at", { ascending: false }),
    customerId
      ? supabase
          .from("quotes")
          .select(
            "id, status, created_at, sent_at, jobs(name), quote_line_items(quantity, unit_price)"
          )
          .eq("customer_id", customerId)
          .eq("status", "sent")
          .order("sent_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    customerId
      ? supabase
          .from("invoices")
          .select(
            "id, status, paid_at, created_at, jobs(name), invoice_line_items(quantity, unit_price)"
          )
          .eq("customer_id", customerId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const jobs = jobsRes.data;
  const pendingQuotes = quotesRes.data;
  const invoices = invoicesRes.data;

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

  const quoteRows = (pendingQuotes ?? []).map((q) => {
    const items =
      (q.quote_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    return {
      id: q.id,
      jobName: (q.jobs as unknown as { name: string } | null)?.name ?? "—",
      sentAt: q.sent_at,
      total: computeTotal(items),
    };
  });

  const invoiceRows = (invoices ?? []).map((inv) => {
    const items =
      (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    return {
      id: inv.id,
      status: inv.status,
      paidAt: inv.paid_at,
      createdAt: inv.created_at,
      jobName: (inv.jobs as unknown as { name: string } | null)?.name ?? "—",
      total: computeTotal(items),
    };
  });

  const unpaidInvoices = invoiceRows.filter((i) => i.status === "sent");

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title={profile?.full_name ?? "Project Portal"}
        subtitle={user.email ?? ""}
        showSignOut
      />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <ClientPullToRefresh>
          {/* Pending quote approvals */}
          {quoteRows.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
                <FileText className="w-4 h-4" />
                Quotes awaiting your approval
              </h2>
              <div className="space-y-2">
                {quoteRows.map((q) => (
                  <Link
                    key={q.id}
                    href={`/quotes/${q.id}`}
                    className="block bg-amber-50 border border-amber-200 rounded-lg p-3 active:bg-amber-100"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 truncate">
                          {q.jobName}
                        </p>
                        <p className="text-xs text-amber-800 mt-0.5">
                          Sent {new Date(q.sentAt).toLocaleDateString()}
                        </p>
                      </div>
                      <span className="text-base font-bold text-gray-900">
                        {formatMoney(q.total)}
                      </span>
                    </div>
                    <p className="text-xs text-amber-900 mt-2">
                      Tap to review and approve →
                    </p>
                  </Link>
                ))}
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