import { CheckCircle2 } from "lucide-react";

// Read-only status banner for the public invoice view. The banner shows invoice
// status and, when online payments are NOT available, a hint to pay per the
// contractor's instructions. For lawn orgs that clear the three-way payment gate
// (lawn + connect_charges_enabled + not platform-liable), the actual Pay / save-
// card actions render in a sibling InvoicePayActions component and this hint is
// suppressed. The "platform never touches customer money / no in-app Pay button"
// wording still applies to construction and to lawn orgs where payments are off
// (not charges-enabled, or platform-liable) — in those cases there is no Pay button.

export default function InvoiceStatusBanner({
  paid,
  balanceDueStr,
  isVoid,
  paymentsEnabled,
}: {
  paid: boolean;
  balanceDueStr: string;
  isVoid: boolean;
  paymentsEnabled: boolean;
}) {
  if (paid) {
    return (
      <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg p-4 flex items-center gap-2">
        <CheckCircle2 className="w-5 h-5 shrink-0" />
        <p className="font-semibold text-sm">This invoice is paid in full. Thank you!</p>
      </div>
    );
  }

  if (isVoid) {
    return (
      <div className="bg-gray-100 border border-gray-200 text-gray-500 rounded-lg p-4 flex items-center gap-2">
        <p className="font-semibold text-sm">This invoice is void.</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between gap-2">
      <p className="text-sm text-gray-600">
        Balance due{" "}
        <span className="font-semibold text-gray-900">{balanceDueStr}</span>
      </p>
      {!paymentsEnabled && (
        <p className="text-xs text-gray-400">
          Pay per your contractor&rsquo;s instructions.
        </p>
      )}
    </div>
  );
}