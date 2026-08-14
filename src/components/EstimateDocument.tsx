// Customer-facing estimate document — pure presentational (server-safe, no
// "use client", no data fetching). Renders the EXACT document the customer
// sees, so the office Preview is literally what the customer receives:
//   • the estimate creator's Preview step (client)
//   • the public /q/[token] portal (server)
//   • the logged-in customer portal (server)
//
// Totals are computed internally via computeEstimateTotals from the same
// {items, pricing} inputs every caller passes — preview and customer view both
// derive the grand total the same way, so they can never drift.
//
// Cost codes, the internal `note`, and any office margin data (internal_cost)
// are NEVER passed in here — callers select only customer-safe columns
// (description, quantity, unit, unit_price, section). Decision buttons are
// rendered by the caller (interactive/client), not by this component.

import { computeEstimateTotals, formatMoney, type EstimatePricing } from "@/lib/money";

export type EstimateDocumentItem = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  section?: string | null;
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
  estimateNumber?: string | null;
  projectAddress?: string | null;
  pricing?: EstimatePricing | null;
  showItemized?: boolean;
  exclusions?: string | null;
  terms?: string | null;
  paymentSchedule?: string | null;
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
  estimateNumber,
  projectAddress,
  pricing,
  showItemized = true,
  exclusions,
  terms,
  paymentSchedule,
  preview = false,
}: EstimateDocumentProps) {
  const validUntilText = fmtDate(validUntil);

  const totals = computeEstimateTotals(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unitPrice })),
    pricing ?? null
  );
  const hasPricing =
    totals.markupAmount > 0 ||
    totals.contingencyAmount > 0 ||
    totals.taxAmount > 0 ||
    totals.depositAmount > 0;
  const grandTotal = hasPricing ? totals.grandTotal : totals.subtotal;

  // Group itemized lines by section, preserving array order. A line with a
  // blank section sits in an unlabeled group (rendered with no header).
  type Group = { section: string | null; items: EstimateDocumentItem[] };
  const groups: Group[] = [];
  for (const item of items) {
    const section = item.section?.trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) {
      last.items.push(item);
    } else {
      groups.push({ section, items: [item] });
    }
  }

  return (
    <div className="bg-gray-50">
      {/* Branded header */}
      <header className="bg-blue-900 px-5 py-5 text-white">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-lg font-bold tracking-tight">{orgName}</p>
            <p className="text-blue-200 text-[11px] uppercase tracking-wider mt-0.5">
              Estimate for your review
            </p>
          </div>
          {estimateNumber && (
            <p className="text-blue-100 text-xs font-semibold flex-shrink-0">
              #{estimateNumber}
            </p>
          )}
        </div>
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
              {formatMoney(grandTotal)}
            </span>
          </div>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Prepared for:</span> {customerName}
          </p>
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">Project:</span> {jobName}
          </p>
          {projectAddress && (
            <p className="text-sm text-gray-700">
              <span className="text-gray-500">Project address:</span>{" "}
              {projectAddress}
            </p>
          )}
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

        {/* Line items (itemized) — no cost codes, no internal cost */}
        {showItemized ? (
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
                {groups.map((group, gi) => (
                  <div key={gi}>
                    {group.section && (
                      <div className="px-3 pt-3 pb-1 bg-gray-50/60">
                        <p className="text-xs font-bold text-gray-700 uppercase tracking-wide">
                          {group.section}
                        </p>
                      </div>
                    )}
                    {group.items.map((item) => {
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
                    {group.section && (
                      <div className="px-3 py-1.5 bg-gray-50/60 text-right text-xs text-gray-500 border-t border-gray-100">
                        {group.section} subtotal{" "}
                        <span className="font-semibold text-gray-700">
                          {formatMoney(
                            group.items.reduce(
                              (s, i) =>
                                s + Number(i.quantity) * Number(i.unitPrice),
                              0
                            )
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
              Lump sum
            </h2>
            <div className="bg-white rounded-lg shadow-sm p-4">
              <p className="text-sm text-gray-700">
                A single lump-sum price for the full scope of work described in
                this estimate.
              </p>
            </div>
          </section>
        )}

        {/* Pricing summary */}
        {hasPricing ? (
          <section className="bg-white rounded-lg shadow-sm p-4 space-y-1.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Subtotal</span>
              <span className="text-gray-900 tabular-nums">
                {formatMoney(totals.subtotal)}
              </span>
            </div>
            {totals.markupAmount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">
                  Overhead &amp; Profit ({Number(pricing?.markupPct ?? 0)}%)
                </span>
                <span className="text-gray-900 tabular-nums">
                  {formatMoney(totals.markupAmount)}
                </span>
              </div>
            )}
            {totals.contingencyAmount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">
                  Contingency ({Number(pricing?.contingencyPct ?? 0)}%)
                </span>
                <span className="text-gray-900 tabular-nums">
                  {formatMoney(totals.contingencyAmount)}
                </span>
              </div>
            )}
            {totals.taxAmount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">
                  Sales Tax ({Number(pricing?.taxPct ?? 0)}%)
                </span>
                <span className="text-gray-900 tabular-nums">
                  {formatMoney(totals.taxAmount)}
                </span>
              </div>
            )}
            <div className="flex justify-between pt-2 border-t border-gray-200">
              <span className="text-sm font-bold text-gray-900">Grand total</span>
              <span className="text-base font-bold text-gray-900 tabular-nums">
                {formatMoney(totals.grandTotal)}
              </span>
            </div>
            {totals.depositAmount > 0 && (
              <>
                <div className="flex justify-between text-sm pt-1">
                  <span className="text-gray-600">Deposit due</span>
                  <span className="text-gray-900 tabular-nums font-medium">
                    {formatMoney(totals.depositAmount)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Balance due</span>
                  <span className="text-gray-900 tabular-nums font-medium">
                    {formatMoney(totals.balanceDue)}
                  </span>
                </div>
              </>
            )}
          </section>
        ) : (
          items.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-3 flex justify-between items-center">
              <span className="text-sm font-semibold text-gray-900">Total</span>
              <span className="text-base font-bold text-gray-900">
                {formatMoney(totals.subtotal)}
              </span>
            </div>
          )
        )}

        {/* Exclusions */}
        {exclusions?.trim() && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">
              Exclusions
            </h2>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">
              {exclusions}
            </p>
          </section>
        )}

        {/* Terms & conditions */}
        {terms?.trim() && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">
              Terms &amp; Conditions
            </h2>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">{terms}</p>
          </section>
        )}

        {/* Payment schedule */}
        {paymentSchedule?.trim() && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-1">
              Payment Schedule
            </h2>
            <p className="text-sm text-gray-900 whitespace-pre-wrap">
              {paymentSchedule}
            </p>
          </section>
        )}

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