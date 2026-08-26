import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getMeIdentity } from "@/lib/tenant";
import { formatMoney } from "@/lib/money";
import type { CoSnapshot } from "@/lib/sends";

export const dynamic = "force-dynamic";

// Office-only: view the immutable send-time snapshot of a change order
// (Issue 3). Reads the `change_order_sends` row by id (service role) + guards
// org. Reproduces the /co/{token} layout the customer saw, from the archived
// JSON — so the office can prove exactly what was sent even if the live CO was
// later revised. The `id` param is the CO id (for the back link); the `sendId`
// param selects the archived send.
export default async function ChangeOrderSnapshotPage({
  params,
}: {
  params: Promise<{ id: string; sendId: string }>;
}) {
  const { id, sendId } = await params;

  const me = await getMeIdentity();
  if (!me || (me.role !== "office" && me.role !== "admin" && !me.isSuperAdmin)) {
    notFound();
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: row } = await admin
    .from("change_order_sends")
    .select("id, change_order_id, organization_id, sent_at, sent_by, sent_via, recipient, snapshot")
    .eq("id", sendId)
    .maybeSingle();

  if (!row) notFound();
  const rowOrgId = (row.organization_id as string | null) ?? null;
  if (!me.isSuperAdmin && me.orgId !== rowOrgId) notFound();
  if ((row.change_order_id as string) !== id) notFound();

  const snap = row.snapshot as unknown as CoSnapshot;
  const co = snap.change_order;
  const isCredit = co.is_credit;
  const lineRows = snap.lines;

  // Mirror /co/[token]: prefer the explicit header amount; fall back to the
  // sum of the lines (when the CO had no header amount).
  const lineTotal = lineRows.reduce(
    (s, l) => s + (l.quantity || 0) * (l.unit_price || 0),
    0
  );
  const total = co.amount !== 0 ? co.amount : lineTotal;
  const showLines = lineRows.length > 0 && co.amount === 0;

  const sentAt = (row.sent_at as string) ?? null;
  const via = (row.sent_via as string) ?? "email";
  const recipient = (row.recipient as string | null) ?? null;
  const jobName = snap.job?.name ?? co.title ?? "your project";

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <Link
          href={`/change-orders/${id}`}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[70%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">Back to change order</span>
        </Link>
        <h1 className="text-sm font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[55%]">
          Sent snapshot
        </h1>
        <div className="w-20" />
      </header>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center text-xs text-amber-800">
          Archived snapshot — sent
          {sentAt ? ` ${new Date(sentAt).toLocaleString()}` : ""}
          {recipient ? ` to ${recipient}` : ""} via {via}. This is exactly what
          the customer received; the live change order may have been revised since.
        </div>

        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-5" style={{ background: "#7c2d12" }}>
            <p className="text-white text-lg font-bold tracking-tight">
              {snap.org.name}
            </p>
            <p className="text-orange-200 text-xs uppercase tracking-wider mt-0.5">
              {isCredit ? "Credit for your review" : "Change Order for your review"}
            </p>
          </div>

          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                {co.co_number && (
                  <p className="text-xs uppercase tracking-wider text-gray-400">
                    Change Order #{co.co_number}
                  </p>
                )}
                <h1 className="text-xl font-bold text-gray-900">{co.title}</h1>
              </div>
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                Awaiting review
              </span>
            </div>

            <div className="text-sm text-gray-600">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">
                Project
              </p>
              <p className="font-medium text-gray-900">{jobName}</p>
            </div>

            {co.description && (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">
                  Description
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {co.description}
                </p>
              </div>
            )}

            {co.reason && (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">
                  Reason
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {co.reason}
                </p>
              </div>
            )}

            {showLines && lineRows.length > 0 && (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">Item</th>
                      <th className="text-right font-semibold px-3 py-2">Qty</th>
                      <th className="text-right font-semibold px-3 py-2">Price</th>
                      <th className="text-right font-semibold px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {lineRows.map((l) => {
                      const code = l.cost_code?.code;
                      return (
                        <tr key={l.position}>
                          <td className="px-3 py-2">
                            {code && (
                              <span className="font-mono text-[11px] text-gray-400 mr-1">
                                {code}
                              </span>
                            )}
                            <span className="text-gray-800">
                              {l.description || l.cost_code?.name || "—"}
                            </span>
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums text-gray-700">
                            {l.quantity}
                            {l.unit ? ` ${l.unit}` : ""}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums text-gray-700">
                            {formatMoney(l.unit_price)}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums font-medium text-gray-900">
                            {formatMoney(l.quantity * l.unit_price)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="border-t pt-4 flex items-center justify-between">
              <span className="text-gray-500 text-sm">
                {isCredit ? "Credit amount" : "Change order total"}
              </span>
              <span className="text-3xl font-bold text-gray-900">
                {formatMoney(total)}
              </span>
            </div>
          </div>
        </div>

        {snap.org.email && (
          <p className="text-center text-[11px] text-gray-400">
            Questions? Contact {snap.org.name} at {snap.org.email}.
          </p>
        )}
      </div>
    </div>
  );
}