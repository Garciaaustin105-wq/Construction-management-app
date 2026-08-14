import { createClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import StatusBadge from "@/components/StatusBadge";
import { formatMoney, computeTotal } from "@/lib/money";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import QuoteActions from "./QuoteActions";
import CustomerQuoteActions from "./CustomerQuoteActions";
import Link from "next/link";

export default async function QuoteDetailPage({
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

  const { data: quote } = await supabase
    .from("quotes")
    .select(
      "id, status, notes, job_id, customer_id, created_at, sent_at, approved_at, jobs(name), customers(name)"
    )
    .eq("id", id)
    .single();

  if (!quote) notFound();

  const { data: lineItems } = await supabase
    .from("quote_line_items")
    .select("id, description, quantity, unit_price, position")
    .eq("quote_id", id)
    .order("position");

  // If approved, find the resulting invoice
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, status, paid_at")
    .eq("quote_id", id)
    .maybeSingle();

  const items = lineItems ?? [];
  const total = computeTotal(
    items.map((i) => ({ quantity: Number(i.quantity), unit_price: Number(i.unit_price) }))
  );
  const jobName = (quote.jobs as unknown as { name: string } | null)?.name ?? "—";
  const customerName = (quote.customers as unknown as { name: string } | null)?.name ?? "—";

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar
        title="Quote"
        subtitle={jobName}
        backHref={jobParam ? `/jobs/${jobParam}` : undefined}
        backLabel={jobParam ? "Back to job" : undefined}
      />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <StatusBadge status={quote.status} size="md" />
            <span className="text-2xl font-bold text-gray-900">
              {formatMoney(total)}
            </span>
          </div>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Customer:</span> {customerName}
          </p>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Job:</span> {jobName}
          </p>
          <p className="text-xs text-gray-400 mt-2">
            Created {new Date(quote.created_at).toLocaleDateString()}
            {quote.sent_at && (
              <> · Sent {new Date(quote.sent_at).toLocaleDateString()}</>
            )}
            {quote.approved_at && (
              <> · Approved {new Date(quote.approved_at).toLocaleDateString()}</>
            )}
          </p>
        </section>

        {quote.notes && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">
              Notes
            </h2>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">
              {quote.notes}
            </p>
          </section>
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
                description="Edit this quote to add line items."
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

        {invoice && (
          <Link
            href={`/invoices/${invoice.id}${jobParam ? `?job=${jobParam}` : ""}`}
            className="block bg-green-50 border border-green-200 rounded-lg p-3 active:bg-green-100"
          >
            <p className="text-xs font-semibold text-green-700 uppercase">
              Converted to Invoice
            </p>
            <p className="text-sm text-green-900 mt-0.5">
              Status: <StatusBadge status={invoice.status} />
            </p>
            <p className="text-xs text-green-700 mt-1">Tap to view →</p>
          </Link>
        )}

        {(role === "office" || role === "admin") && (
          <QuoteActions
            quoteId={quote.id}
            status={quote.status}
            invoiceId={invoice?.id ?? null}
            jobId={jobParam ?? null}
          />
        )}

        {role === "customer" && quote.status === "sent" && (
          <CustomerQuoteActions quoteId={quote.id} />
        )}
      </main>

    </div>
  );
}