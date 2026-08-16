import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/money";
import CODecisionButtons from "./CODecisionButtons";

export const dynamic = "force-dynamic";

// Public customer change-order view — no auth. The share_token in the URL is
// the only credential. Fetched via the service role. Office hits Send →
// customer opens this link → sees the change order + Approve/Reject → decides
// at /api/change-orders/by-token/[token]/decide.
//
// Selects customer-safe columns + the cost-coded lines (the customer may see
// what the CO covers). The first open stamps viewed_at (fire-and-forget) so
// the office knows the customer looked.
export default async function PublicChangeOrderPage({
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

  const { data: co } = await admin
    .from("change_orders")
    .select(
      "id, title, description, reason, amount, is_credit, co_number, status, sent_at, approved_at, rejected_at, organization_id, job_id, jobs(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!co) {
    notFound();
  }

  // Stamp viewed_at on first open (only if still null). Fire-and-forget.
  if (co.status === "sent") {
    void admin
      .from("change_orders")
      .update({ viewed_at: new Date().toISOString() })
      .eq("share_token", token)
      .is("viewed_at", null);
  }

  const { data: lines } = await admin
    .from("change_order_lines")
    .select("id, description, quantity, unit, unit_price, position, cost_codes(code, name)")
    .eq("change_order_id", co.id)
    .order("position");

  let orgName = "";
  let orgEmail: string | null = null;
  if (co.organization_id) {
    const { data: orgRow } = await admin
      .from("organizations")
      .select("name, email")
      .eq("id", co.organization_id)
      .maybeSingle();
    if (orgRow?.name) orgName = orgRow.name as string;
    orgEmail = (orgRow?.email as string | null)?.trim() || null;
  }

  const jobName =
    (co.jobs as unknown as { name: string } | null)?.name ??
    co.title ??
    "your project";

  const amount = Number(co.amount) || 0;
  const isCredit = !!co.is_credit;
  const lineRows = (lines ?? []) as unknown as {
    id: string;
    description: string | null;
    quantity: number;
    unit: string | null;
    unit_price: number;
    // PostgREST returns a single object for this FK join; supabase-js types it
    // as an array, so we cast through unknown and read it as an object.
    cost_codes: { code: string; name: string } | null;
  }[];
  const lineTotal = lineRows.reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0),
    0
  );
  // Prefer the explicit header amount; fall back to the sum of the lines.
  const total = amount !== 0 ? amount : lineTotal;
  const showLines = lineRows.length > 0 && amount === 0;

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; cls: string }> = {
      sent: { label: "Awaiting your review", cls: "bg-blue-100 text-blue-700" },
      approved: { label: "Approved", cls: "bg-green-100 text-green-700" },
      rejected: { label: "Declined", cls: "bg-red-100 text-red-700" },
      void: { label: "Void", cls: "bg-gray-100 text-gray-600" },
    };
    const s = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-600" };
    return <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.cls}`}>{s.label}</span>;
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-5" style={{ background: "#7c2d12" }}>
            <p className="text-white text-lg font-bold tracking-tight">{orgName}</p>
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
              {statusBadge(co.status)}
            </div>

            <div className="text-sm text-gray-600">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-0.5">Project</p>
              <p className="font-medium text-gray-900">{jobName}</p>
            </div>

            {co.description && (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Description</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{co.description}</p>
              </div>
            )}

            {co.reason && (
              <div>
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Reason</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{co.reason}</p>
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
                      const code = l.cost_codes?.code;
                      return (
                        <tr key={l.id}>
                          <td className="px-3 py-2">
                            {code && (
                              <span className="font-mono text-[11px] text-gray-400 mr-1">{code}</span>
                            )}
                            <span className="text-gray-800">{l.description || l.cost_codes?.name || "—"}</span>
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums text-gray-700">
                            {Number(l.quantity) || 0}
                            {l.unit ? ` ${l.unit}` : ""}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums text-gray-700">
                            {formatMoney(Number(l.unit_price) || 0)}
                          </td>
                          <td className="text-right px-3 py-2 tabular-nums font-medium text-gray-900">
                            {formatMoney((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
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

            {co.status === "approved" && co.approved_at && (
              <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">
                You approved this change order on{" "}
                {new Date(co.approved_at).toLocaleString()}.
              </p>
            )}
            {co.status === "rejected" && co.rejected_at && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                You declined this change order on{" "}
                {new Date(co.rejected_at).toLocaleString()}.
              </p>
            )}

            {co.status === "sent" && (
              <p className="text-xs text-gray-400">
                Please review and approve or decline below. Approving authorizes
                this {isCredit ? "credit" : "change"} to proceed.
              </p>
            )}
          </div>
        </div>

        {co.status === "sent" && (
          <div className="max-w-md mx-auto mt-4 px-4">
            <CODecisionButtons token={token} />
          </div>
        )}

        {orgEmail && (
          <p className="text-center text-[11px] text-gray-400 mt-4">
            Questions? Contact {orgName} at {orgEmail}.
          </p>
        )}
      </div>
    </div>
  );
}