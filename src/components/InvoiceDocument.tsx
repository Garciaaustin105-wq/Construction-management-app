// Customer-facing invoice document — pure presentational (server-safe, no
// "use client", no data fetching). Renders the EXACT document the customer
// sees, so the office Preview is literally what the customer receives:
//   • the invoice creator's Preview step (client)
//   • the public /i/[token] portal (server)
//   • the logged-in customer portal (server)
//
// Totals are computed internally via computeEstimateTotals from the same
// {items, pricing} inputs every caller passes — preview and customer view both
// derive the grand total the same way, so they can never drift.
//
// Cost codes, the internal `note`, and any office margin data (internal_cost)
// are NEVER passed in here — callers select only customer-safe columns
// (description, quantity, unit, unit_price). Decision buttons are
// rendered by the caller (interactive/client), not by this component.

import { formatMoney } from "@/lib/money";

export type InvoiceDocumentProps = {
  orgName: string;
  orgAddress?: string | null;
  orgPhone?: string | null;
  orgEmail?: string | null;
  // White-label: the org's uploaded logo public URL. When set, shown in the
  // document header beside the org name (on a white chip so colored logos stay
  // readable against the dark header). Null → orgName text only (default).
  orgLogoUrl?: string | null;
  customerName: string;
  jobName: string;
  status: string;
  sentAt?: string | null;
  dueDate?: string | null;
  items: {
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
  }[];
  total: number;
  amountPaid: number;
  balanceDue: number;
};

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString() : null;

export default function InvoiceDocument({
  orgName,
  orgAddress,
  orgPhone,
  orgEmail,
  orgLogoUrl,
  customerName,
  jobName,
  status,
  sentAt,
  dueDate,
  items,
  total,
  amountPaid,
  balanceDue,
}: InvoiceDocumentProps) {
  const sentAtText = fmtDate(sentAt);
  const dueDateText = fmtDate(dueDate);

  return (
    <div className="bg-gray-50">
      {/* Branded header */}
      <header className="bg-brand-dark px-5 py-5 text-white">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex items-center gap-3">
            {orgLogoUrl && (
              // White chip so a colored logo stays readable on the dark header.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={orgLogoUrl}
                alt={orgName}
                className="h-10 w-auto max-w-[150px] shrink-0 object-contain rounded bg-white p-1"
              />
            )}
            <div className="min-w-0">
              <p className="text-lg font-bold tracking-tight">{orgName}</p>
              <p className="text-brand-bg text-[11px] uppercase tracking-wider mt-0.5">
                Invoice
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-md mx-auto p-4 space-y-4">
        {/* Summary */}
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full font-semibold uppercase ${
                status === "paid"
                  ? "bg-green-100 text-green-700"
                  : status === "overdue"
                  ? "bg-red-100 text-red-700"
                  : "bg-blue-100 text-blue-700"
              }`}
            >
              {status}
            </span>
            <span className="text-2xl font-bold text-gray-900">
              {formatMoney(total)}
            </span>
          </div>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Billed to:</span> {customerName}
          </p>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Project:</span> {jobName}
          </p>
          {(sentAtText || dueDateText) && (
            <p className="text-xs text-gray-400 mt-2">
              {sentAtText ? `Sent ${sentAtText}` : ""}
              {sentAtText && dueDateText ? " · " : ""}
              {dueDateText ? `Due ${dueDateText}` : ""}
            </p>
          )}
        </section>

        {/* Line items (itemized) */}
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
                const lineTotal = Number(item.quantity) * Number(item.unitPrice);
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
                      {item.quantity} × {formatMoney(Number(item.unitPrice))}
                    </p>
                  </div>
                );
              })}
              <div className="p-3 text-right">
                <p className="text-sm font-semibold text-gray-900">
                  Total: {formatMoney(total)}
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Totals */}
        <section className="bg-white rounded-lg shadow-sm p-4 space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Invoice total</span>
            <span className="text-gray-900 tabular-nums">
              {formatMoney(total)}
            </span>
          </div>
          {amountPaid > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Paid so far</span>
              <span className="text-gray-900 tabular-nums font-medium">
                -{formatMoney(amountPaid)}
              </span>
            </div>
          )}
          <div className="flex justify-between pt-2 border-t border-gray-200">
            <span className="text-sm font-bold text-gray-900">Balance due</span>
            <span className="text-base font-bold text-gray-900 tabular-nums">
              {formatMoney(balanceDue)}
            </span>
          </div>
        </section>

        {/* Org footer */}
        {(orgAddress || orgPhone || orgEmail) && (
          <section className="bg-white rounded-lg p-4 shadow-sm text-xs text-gray-500 space-y-0.5">
            <p className="font-semibold text-gray-700">{orgName}</p>
            {orgAddress && <p>{orgAddress}</p>}
            {orgPhone && <p>{orgPhone}</p>}
            {orgEmail && <p>{orgEmail}</p>}
          </section>
        )}
      </div>
    </div>
  );
}