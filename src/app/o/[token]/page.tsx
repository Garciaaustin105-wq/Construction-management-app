import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/money";
import {
  describeSupplierDoc,
  orderTotal,
  unpricedItems,
  type MaterialOrderItem,
} from "@/lib/materialOrders";

// Public supplier view of a material order — no auth. The share_token in the
// URL is the credential, same as /q for an estimate and /s for a submittal.
//
// WHAT THIS PAGE MUST NEVER SHOW, and why the queries are shaped the way they
// are: an order belongs to an estimate, which belongs to a job, which belongs
// to a CUSTOMER. A supplier needs to know what to supply, not who it is for.
// So nothing here joins to estimates, jobs or customers — the two selects below
// touch material_orders and material_order_items and stop. There is no path
// from this link to a customer's name or address because the data to build one
// is never fetched.
//
// Prices are the org's opt-in. unit_cost is what THEY expect to pay and may
// have come from a different supplier; showing it unasked is how a discount
// gets lost. Off, the page reads as a request for a quote. On, as an order.

export const dynamic = "force-dynamic";

type Order = {
  id: string;
  organization_id: string;
  status: string;
  supplier: string | null;
  note: string | null;
  delivery_note: string | null;
  show_prices: boolean;
  placed_at: string | null;
  created_at: string;
};

export default async function SupplierOrderPage({
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

  const { data: orderRow } = await admin
    .from("material_orders")
    // Explicit, and short on purpose. A `*` here would start shipping every
    // column added to this table later — including any that name the job.
    .select(
      "id, organization_id, status, supplier, note, delivery_note, show_prices, placed_at, created_at"
    )
    .eq("share_token", token)
    .maybeSingle();

  // A wrong or revoked token is a 404, not an error page that confirms the
  // token was ALMOST right.
  if (!orderRow) notFound();
  const order = orderRow as unknown as Order;

  const [{ data: itemRows }, { data: orgRow }] = await Promise.all([
    admin
      .from("material_order_items")
      .select("id, material_order_id, snapshot, quantity, unit, unit_cost")
      .eq("material_order_id", order.id),
    // The supplier needs to know who is asking. The org's own name only.
    admin
      .from("organizations")
      .select("name")
      .eq("id", order.organization_id)
      .maybeSingle(),
  ]);

  const items = (itemRows ?? []) as unknown as MaterialOrderItem[];
  const orgName = (orgRow as { name: string } | null)?.name ?? "";
  const total = orderTotal(items);
  const unpriced = unpricedItems(items);

  const unitLabel: Record<string, string> = {
    each: "ea",
    foot: "ft",
    pallet: "pallet",
  };

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="rounded-lg border border-gray-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            {order.show_prices ? "Material order" : "Request for quote"}
          </p>
          <h1 className="mt-1 text-lg font-bold text-gray-900">{orgName}</h1>
          {order.supplier && (
            <p className="mt-0.5 text-sm text-gray-600">For: {order.supplier}</p>
          )}
          <p className="mt-3 text-xs leading-relaxed text-gray-600">
            {describeSupplierDoc(order)}
          </p>
        </header>

        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            {items.length} line{items.length === 1 ? "" : "s"}
          </h2>
          <div className="mt-3 divide-y divide-gray-100">
            {items.map((i) => {
              const snap = i.snapshot;
              return (
                <div key={i.id} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">
                      {snap?.label ?? "Item"}
                    </p>
                    {snap?.detail && (
                      <p className="text-xs text-gray-500">{snap.detail}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="text-sm font-semibold text-gray-900">
                      {i.quantity} {unitLabel[i.unit] ?? i.unit}
                    </p>
                    {/* Money only when the org asked for it, and 0 is still not
                        free — an unpriced line says so rather than showing
                        $0.00 for a supplier to take literally. */}
                    {order.show_prices && (
                      <p className="text-xs text-gray-500">
                        {i.unit_cost > 0
                          ? `${formatMoney(i.unit_cost)}/${unitLabel[i.unit] ?? i.unit}`
                          : "price not set"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {order.show_prices && (
            <div className="mt-3 flex items-center justify-between border-t border-gray-200 pt-3">
              <span className="text-sm font-semibold text-gray-900">Total</span>
              <span className="text-sm font-semibold text-gray-900 tabular-nums">
                {formatMoney(total)}
              </span>
            </div>
          )}
          {order.show_prices && unpriced > 0 && (
            <p className="mt-2 text-xs text-amber-800">
              {unpriced} line{unpriced === 1 ? "" : "s"} have no price set, so
              this total is not the whole order. Please quote those.
            </p>
          )}
        </section>

        {(order.delivery_note || order.note) && (
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              Notes
            </h2>
            {order.delivery_note && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
                {order.delivery_note}
              </p>
            )}
            {order.note && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">
                {order.note}
              </p>
            )}
          </section>
        )}

        <p className="px-1 text-[11px] text-gray-400">
          Sent from {orgName}. Reply to whoever sent you this link — this page
          does not take a response.
        </p>
      </div>
    </main>
  );
}
