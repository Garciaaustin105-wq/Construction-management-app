import { createClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import StatusBadge from "@/components/StatusBadge";
import { formatMoney, computeTotal } from "@/lib/money";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import InvoiceActions from "./InvoiceActions";
import InvoiceDueDate from "./InvoiceDueDate";
import Link from "next/link";

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { id } = await params;
  const { job: jobParam } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";

  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      "id, status, paid_at, created_at, due_date, job_id, customer_id, estimate_id, amount_paid, jobs(name), customers(name)"
    )
    .eq("id", id)
    .single();

  if (!invoice) notFound();

  const { data: lineItems } = await supabase
    .from("invoice_line_items")
    .select("id, description, quantity, unit_price, position")
    .eq("invoice_id", id)
    .order("position");

  const items = lineItems ?? [];
  const total = computeTotal(
    items.map((i) => ({ quantity: Number(i.quantity), unit_price: Number(i.unit_price) }))
  );
  // amount_paid is seeded with the estimate deposit on approval. The balance
  // due is the grand total minus what's been paid (0 when fully paid).
  const amountPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - amountPaid);
  const jobName = (invoice.jobs as unknown as { name: string } | null)?.name ?? "—";
  const customerName = (invoice.customers as unknown as { name: string } | null)?.name ?? "—";

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title="Invoice"
        subtitle={customerName}
        backHref={jobParam ? `/jobs/${jobParam}` : undefined}
        backLabel={jobParam ? "Back to job" : undefined}
      />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <StatusBadge status={invoice.status} size="md" />
            <span className="text-2xl font-bold text-gray-900">
              {formatMoney(total)}
            </span>
          </div>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Customer:</span> {customerName}
          </p>
          {invoice.job_id ? (
            <p className="text-sm text-gray-700">
              <span className="text-gray-500">Job:</span>{" "}
              <Link href={`/jobs/${invoice.job_id}`} className="text-blue-600 underline">
                {jobName}
              </Link>
            </p>
          ) : (
            <p className="text-sm text-gray-700">
              <span className="text-gray-500">Job:</span>{" "}
              <span className="text-gray-500">Standalone estimate (no job)</span>
            </p>
          )}
          <InvoiceDueDate
            invoiceId={invoice.id}
            initial={invoice.due_date}
            canEdit={
              role === "office" ||
              role === "admin" ||
              role === "project_manager"
            }
          />
          <p className="text-xs text-gray-400 mt-2">
            Issued {new Date(invoice.created_at).toLocaleDateString()}
            {invoice.paid_at && (
              <> · Paid {new Date(invoice.paid_at).toLocaleDateString()}</>
            )}
          </p>
          {amountPaid > 0 && invoice.status !== "paid" && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-1 text-sm">
              <div className="flex justify-between text-gray-500">
                <span>Invoice total</span>
                <span className="tabular-nums">{formatMoney(total)}</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>Paid so far (deposit applied)</span>
                <span className="tabular-nums">−{formatMoney(amountPaid)}</span>
              </div>
              <div className="flex justify-between font-semibold text-gray-900">
                <span>Balance due</span>
                <span className="tabular-nums">{formatMoney(balanceDue)}</span>
              </div>
            </div>
          )}
        </section>

        {invoice.estimate_id && (
          <Link
            href={`/estimates/${invoice.estimate_id}${jobParam ? `?job=${jobParam}` : ""}`}
            className="block bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900 active:bg-blue-100"
          >
            ← View source estimate
          </Link>
        )}

        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
            Line items ({items.length})
          </h2>
          {items.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.FileText}
                title="No line items"
                description="This invoice has no items."
              />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {items.map((item) => {
                const lineTotal =
                  Number(item.quantity) * Number(item.unit_price);
                return (
                  <div key={item.id} className="p-3">
                    <div className="flex justify-between items-start gap-2">
                      <p className="text-sm text-gray-900 flex-1 min-w-0">
                        {item.description}
                      </p>
                      <p className="text-sm font-semibold text-gray-900">
                        {formatMoney(lineTotal)}
                      </p>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.quantity} × {formatMoney(Number(item.unit_price))}
                    </p>
                  </div>
                );
              })}
              <div className="p-3 bg-gray-50 flex justify-between items-center rounded-b-lg">
                <span className="text-sm font-semibold text-gray-900">Total</span>
                <span className="text-base font-bold text-gray-900">
                  {formatMoney(total)}
                </span>
              </div>
            </div>
          )}
        </section>

        {(role === "office" || role === "admin" || role === "project_manager") && (
          <InvoiceActions invoiceId={invoice.id} status={invoice.status} />
        )}
      </main>

    </div>
  );
}