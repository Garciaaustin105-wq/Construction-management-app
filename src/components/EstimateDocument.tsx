// Customer-facing estimate document — pure presentational (server-safe, no
// "use client", no data fetching). Renders the EXACT document the customer
// sees: branded header → status → summary → customer note → itemized lines
// (NO cost codes) → total → org footer. Reused in three places so the office
// Preview is literally what the customer receives:
//   • the estimate creator's Preview step (client)
//   • the public /q/[token] portal (server)
//   • the logged-in customer portal (server)
//
// Cost codes, the internal `note`, and any office margin data are NEVER passed
// in here — callers select only customer-safe columns (description, quantity,
// unit, unit_price). Decision buttons are rendered by the caller (they're
// interactive/client), not by this component.

import { formatMoney } from "@/lib/money";

export type EstimateDocumentItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
};

export type EstimateDocumentProps = {
  orgName: string;
  orgAddress?: string | null;
  orgPhone?: string | null;
  orgEmail?: string | null;
  customerName: string;
  jobName: string;
  status: string;
  sentAt?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  validUntil?: string | null;
  customerNotes?: string | null;
  items: EstimateDocumentItem[];
  total: number;
  // "Preview" overlay (office creator) — stamps a non-customer banner so the
  // office never mistakes a preview for a sent document. Off by default.
  preview?: boolean;
};

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString() : null;

export default function EstimateDocument({
  orgName,
  orgAddress,
  orgPhone,
  orgEmail,
  customerName,
  jobName,
  status,
  sentAt,
  approvedAt,
  rejectedAt,
  validUntil,
  customerNotes,
  items,
  total,
  preview = false,
}: EstimateDocumentProps) {
  const validUntilText = fmtDate(validUntil);

  return (
    <div className="bg-gray-50">
      {/* Branded header */}
      <header className="bg-blue-900 px-5 py-5 text-white">
        <p className="text-lg font-bold tracking-tight">{orgName}</p>
        <p className="text-blue-200 text-[11px] uppercase tracking-wider mt-0.5">
          Estimate for your review
        </p>
      </header>

      <div className="max-w-md mx-auto p-4 space-y-4">
        {preview && (
          <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-center">
            <p className="text-amber-900 text-sm font-semibold">
              Preview — not yet sent
            </p>
            <p className="text-xs text-amber-800 mt-0.5">
              This is exactly what the customer will receive when you press Send.
            </p>
          </div>
        )}

        {/* Status banner */}
        {status === "approved" && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <p className="text-green-800 font-semibold">
              ✓ Approved
              {fmtDate(approvedAt) ? ` on ${fmtDate(approvedAt)}` : ""}
            </p>
            <p className="text-sm text-green-700 mt-1">
              An invoice has been issued. {orgName} will be in touch about next
              steps.
            </p>
          </div>
        )}
        {status === "rejected" && (
          <div className="bg-gray-100 border border-gray-200 rounded-lg p-4 text-center">
            <p className="text-gray-800 font-semibold">
              This estimate was rejected
              {fmtDate(rejectedAt) ? ` on ${fmtDate(rejectedAt)}` : ""}
            </p>
            <p className="text-sm text-gray-600 mt-1">
              Reach out to {orgName} if you&rsquo;d like to revisit it.
            </p>
          </div>
        )}

        {/* Summary */}
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full font-semibold uppercase ${
                status === "approved"
                  ? "bg-green-100 text-green-700"
                  : status === "rejected"
                  ? "bg-gray-200 text-gray-700"
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
            <span className="text-gray-500">Prepared for:</span> {customerName}
          </p>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Project:</span> {jobName}
          </p>
          {(fmtDate(sentAt) || validUntilText) && (
            <p className="text-xs text-gray-400 mt-2">
              {fmtDate(sentAt) ? `Sent ${fmtDate(sentAt)}` : ""}
              {fmtDate(sentAt) && validUntilText ? " · " : ""}
              {validUntilText ? `Valid until ${validUntilText}` : ""}
            </p>
          )}
        </section>

        {customerNotes && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">
              Note from {orgName}
            </h2>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">
              {customerNotes}
            </p>
          </section>
        )}

        {/* Line items (no cost codes) */}
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
                const lineTotal =
                  Number(item.quantity) * Number(item.unitPrice);
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
              <div className="p-3 bg-gray-50 flex justify-between items-center rounded-b-lg">
                <span className="text-sm font-semibold text-gray-900">
                  Total
                </span>
                <span className="text-base font-bold text-gray-900">
                  {formatMoney(total)}
                </span>
              </div>
            </div>
          )}
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