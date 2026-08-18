import { CheckCircle2 } from "lucide-react";

// Read-only status banner for the public invoice view. Per the payments pivot
// the platform never touches customer money — there is NO in-app Pay button
// (no Stripe Checkout / Pay Here). The customer pays on their OWN accounting
// provider's pay page (QBO/Xero/FreshBooks), or offline (cash/check) which the
// office records. This page is a statement only. Pure presentational — no
// client hooks, no fetch, no Stripe.
export default function InvoiceStatusBanner({
  paid,
  balanceDueStr,
  isVoid,
}: {
  paid: boolean;
  balanceDueStr: string;
  isVoid: boolean;
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
      <p className="text-xs text-gray-400">
        Pay per your contractor&rsquo;s instructions.
      </p>
    </div>
  );
}