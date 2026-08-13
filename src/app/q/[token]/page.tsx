import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { formatMoney, computeTotal } from "@/lib/money";
import QuoteDecisionButtons from "./QuoteDecisionButtons";

export const dynamic = "force-dynamic";

// Public customer quote view — no auth. The share_token in the URL is the only
// credential. Fetched via the service role (validating the token). Office hits
// Send → customer opens this link → sees the quote + Approve/Reject → decides.
export default async function PublicQuotePage({
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

  const { data: quote } = await admin
    .from("quotes")
    .select(
      "id, status, notes, valid_until, sent_at, approved_at, rejected_at, organization_id, jobs(name), customers(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!quote) {
    notFound();
  }

  const { data: lineItems } = await admin
    .from("quote_line_items")
    .select("id, description, quantity, unit_price, position")
    .eq("quote_id", quote.id)
    .order("position");

  let orgName = "Terra Vista Construction";
  let orgAddress: string | null = null;
  let orgPhone: string | null = null;
  let orgEmail: string | null = null;
  if (quote.organization_id) {
    const { data: o } = await admin
      .from("organizations")
      .select("name, address, phone, email")
      .eq("id", quote.organization_id)
      .maybeSingle();
    if (o) {
      if (o.name) orgName = o.name;
      orgAddress = o.address;
      orgPhone = o.phone;
      orgEmail = o.email;
    }
  }

  const jobName = (quote.jobs as unknown as { name: string } | null)?.name ?? "—";
  const customerName =
    (quote.customers as unknown as { name: string } | null)?.name ?? "—";

  const items = lineItems ?? [];
  const total = computeTotal(
    items.map((i) => ({ quantity: Number(i.quantity), unit_price: Number(i.unit_price) }))
  );

  const fmtDate = (s: string | null) =>
    s ? new Date(s).toLocaleDateString() : null;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Branded header */}
      <header className="bg-blue-900 px-5 py-5 text-white">
        <p className="text-lg font-bold tracking-tight">{orgName}</p>
        <p className="text-blue-200 text-[11px] uppercase tracking-wider mt-0.5">
          Quote for your review
        </p>
      </header>

      <main className="max-w-md mx-auto p-4 space-y-4">
        {/* Status banner */}
        {quote.status === "approved" && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <p className="text-green-800 font-semibold">
              ✓ Approved{fmtDate(quote.approved_at) ? ` on ${fmtDate(quote.approved_at)}` : ""}
            </p>
            <p className="text-sm text-green-700 mt-1">
              An invoice has been issued. {orgName} will be in touch about next steps.
            </p>
          </div>
        )}
        {quote.status === "rejected" && (
          <div className="bg-gray-100 border border-gray-200 rounded-lg p-4 text-center">
            <p className="text-gray-800 font-semibold">
              This quote was rejected{fmtDate(quote.rejected_at) ? ` on ${fmtDate(quote.rejected_at)}` : ""}
            </p>
            <p className="text-sm text-gray-600 mt-1">
              Reach out to {orgName} if you'd like to revisit it.
            </p>
          </div>
        )}

        {/* Summary */}
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full font-semibold uppercase ${
                quote.status === "approved"
                  ? "bg-green-100 text-green-700"
                  : quote.status === "rejected"
                  ? "bg-gray-200 text-gray-700"
                  : "bg-blue-100 text-blue-700"
              }`}
            >
              {quote.status}
            </span>
            <span className="text-2xl font-bold text-gray-900">
              {formatMoney(total)}
            </span>
          </div>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Prepared for:</span> {customerName}
          </p>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Project:</span> {jobName}
          </p>
          {fmtDate(quote.sent_at) && (
            <p className="text-xs text-gray-400 mt-2">
              Sent {fmtDate(quote.sent_at)}
              {quote.valid_until
                ? ` · Valid until ${fmtDate(quote.valid_until)}`
                : ""}
            </p>
          )}
        </section>

        {quote.notes && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">
              Note from {orgName}
            </h2>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">
              {quote.notes}
            </p>
          </section>
        )}

        {/* Line items */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
            Line items ({items.length})
          </h2>
          {items.length === 0 ? (
            <div className="bg-white rounded-lg p-4 text-sm text-gray-500">
              No line items.
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {items.map((item) => {
                const lineTotal = Number(item.quantity) * Number(item.unit_price);
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

        {/* Decision buttons only while awaiting the customer */}
        {quote.status === "sent" && <QuoteDecisionButtons token={token} />}

        {/* Org footer */}
        {(orgAddress || orgPhone || orgEmail) && (
          <section className="bg-white rounded-lg p-4 shadow-sm text-xs text-gray-500 space-y-0.5">
            <p className="font-semibold text-gray-700">{orgName}</p>
            {orgAddress && <p>{orgAddress}</p>}
            {orgPhone && <p>{orgPhone}</p>}
            {orgEmail && <p>{orgEmail}</p>}
          </section>
        )}
      </main>
    </div>
  );
}