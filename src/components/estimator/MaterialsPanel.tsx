"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ClipboardList, Loader2, PackageSearch, Trash2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { formatMoney } from "@/lib/money";
import {
  describeStatus,
  describeSupplierDoc,
  draftFromTakeoff,
  orderSharePath,
  sendProblem,
  exclusionWarning,
  orderProblem,
  orderTotal,
  unpricedItems,
  type MaterialOrderStatus,
  type MaterialOrderWithItems,
} from "@/lib/materialOrders";
import {
  createMaterialOrder,
  deleteMaterialOrder,
  listMaterialOrders,
  setMaterialOrderStatus,
} from "@/lib/materialOrdersData";
import {
  buildMaterialTakeoff,
  sodLeftoverSqft,
  takeoffWarning,
  type MaterialLine,
  type TakeoffInput,
} from "@/lib/materialTakeoff";

// What has to be BOUGHT for this estimate — the shopping list, not the quote.
//
// TWO THINGS ON ONE SCREEN, and the difference between them is the point.
//
// The TAKE-OFF is live and has no editable field: it is derived from what is on
// the estimate, so change the estimate and it follows. Letting someone type a
// quantity here would put a number on screen that silently disagrees with the
// map. It is computed from props rather than fetched, because the workspace
// already holds the areas and component rows — querying again would add a round
// trip, a second RLS surface, and a window where the list disagrees with the
// screen it sits on.
//
// An ORDER is a copy, frozen. Once a supplier is holding the paperwork the
// numbers stopped being ours to change, so orders are read from their own rows
// and never recomputed. They render ABOVE the take-off: a document someone is
// acting on outranks a list that is still moving.

type Props = {
  areas: TakeoffInput["areas"];
  components: TakeoffInput["components"];
  organizationId: string;
  estimateId: string;
  /** Estimates lock when they leave draft; so does raising orders against them. */
  canEdit: boolean;
};

const UNIT_LABEL: Record<MaterialLine["unit"], string> = {
  each: "ea",
  foot: "ft",
  pallet: "pallet",
};

const SOURCE_LABEL: Record<MaterialLine["source"], string> = {
  plant: "Plants",
  sod: "Sod",
  head: "Heads",
  component: "Parts",
};

export default function MaterialsPanel({
  areas,
  components,
  organizationId,
  estimateId,
  canEdit,
}: Props) {
  const supabase = useMemo(() => createClient(), []);
  const toast = useToast();
  const [orders, setOrders] = useState<MaterialOrderWithItems[]>([]);
  const [busy, setBusy] = useState(false);
  const [supplier, setSupplier] = useState("");

  // Bumped after every write instead of calling a loader directly, matching the
  // async-IIFE pattern the workspace already uses. A `void reload()` in the
  // effect body trips react-hooks/set-state-in-effect, and the cancelled guard
  // is what stops a slow response from a previous estimate landing on this one.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await listMaterialOrders(supabase, estimateId);
      if (cancelled) return;
      if (error) {
        toast.error(error);
        return;
      }
      setOrders(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, estimateId, toast, reloadKey]);

  const takeoff = useMemo(
    () => buildMaterialTakeoff({ areas, components }),
    [areas, components]
  );
  const leftover = useMemo(
    () => sodLeftoverSqft({ areas, components }),
    [areas, components]
  );
  const warning = takeoffWarning(takeoff);
  const draft = useMemo(() => draftFromTakeoff(takeoff), [takeoff]);
  const cannotOrder = orderProblem(draft);
  const willExclude = exclusionWarning(draft);

  async function raiseOrder() {
    setBusy(true);
    const { error } = await createMaterialOrder(supabase, {
      organizationId,
      estimateId,
      draft,
      supplier,
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    setSupplier("");
    toast.success("Order drafted — nothing has been sent yet");
    setReloadKey((k) => k + 1);
  }

  async function move(order: MaterialOrderWithItems, to: MaterialOrderStatus) {
    setBusy(true);
    const error = await setMaterialOrderStatus(supabase, order, to);
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    setReloadKey((k) => k + 1);
  }

  // Clipboard, not a mailto. The org sends it however they already talk to
  // that supplier — and a copied link cannot half-send.
  async function copyLink(order: MaterialOrderWithItems) {
    const url = `${window.location.origin}${orderSharePath(order)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Supplier link copied");
    } catch {
      // A denied clipboard permission must not leave them with nothing, so the
      // link goes where it can still be selected by hand.
      toast.error(url);
    }
  }

  async function remove(order: MaterialOrderWithItems) {
    setBusy(true);
    const error = await deleteMaterialOrder(supabase, order);
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    setReloadKey((k) => k + 1);
  }

  // Orders already raised. Rendered above the live take-off, because a document
  // a supplier is holding matters more than a list that is still moving.
  const ordersBlock = orders.length > 0 && (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        Orders
      </p>
      {orders.map((o) => {
        const total = orderTotal(o.items);
        const unpriced = unpricedItems(o.items);
        return (
          <div key={o.id} className="rounded-lg border border-gray-200 bg-white p-2.5 space-y-1.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-gray-900">
                  {o.supplier || "No supplier named"}
                </p>
                <p className="text-[11px] text-gray-500">{describeStatus(o.status)}</p>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="text-xs font-semibold text-gray-900">{formatMoney(total)}</p>
                <p className="text-[11px] text-gray-500">
                  {o.items.length} line{o.items.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            {/*
              The supplier link. Copied rather than sent: this app does not
              know the supplier's email, and inventing a send button that only
              copies would be a lie about what happened.
            */}
            {canEdit && (
              <div className="rounded border border-gray-200 bg-gray-50 p-2 space-y-1.5">
                <p className="text-[11px] leading-snug text-gray-600">
                  {describeSupplierDoc(o)}
                </p>
                {(() => {
                  const problem = sendProblem(o, o.items.length);
                  if (problem) {
                    return <p className="text-[11px] text-amber-800">{problem}</p>;
                  }
                  return (
                    <button
                      onClick={() => void copyLink(o)}
                      disabled={busy}
                      className="text-[11px] font-semibold text-slate-700 bg-white border border-gray-300 rounded-lg px-2.5 py-1 active:bg-gray-100 disabled:opacity-50"
                    >
                      Copy supplier link
                    </button>
                  );
                })()}
              </div>
            )}
            {unpriced > 0 && (
              <p className="text-[11px] text-amber-800">
                {unpriced} line{unpriced === 1 ? "" : "s"} on this order have no
                cost, so {formatMoney(total)} is not the whole bill.
              </p>
            )}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {o.status === "draft" && (
                  <button
                    onClick={() => void move(o, "placed")}
                    disabled={busy}
                    className="text-[11px] font-semibold text-white bg-slate-900 rounded-lg px-2.5 py-1 active:bg-slate-800 disabled:opacity-50"
                  >
                    Mark placed
                  </button>
                )}
                {o.status === "placed" && (
                  <button
                    onClick={() => void move(o, "received")}
                    disabled={busy}
                    className="text-[11px] font-semibold text-white bg-slate-900 rounded-lg px-2.5 py-1 active:bg-slate-800 disabled:opacity-50"
                  >
                    Mark received
                  </button>
                )}
                {(o.status === "draft" || o.status === "placed") && (
                  <button
                    onClick={() => void move(o, "canceled")}
                    disabled={busy}
                    className="text-[11px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 active:bg-gray-100 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
                {/* Only a draft can be deleted. A placed order is a record. */}
                {o.status === "draft" && (
                  <button
                    onClick={() => void remove(o)}
                    disabled={busy}
                    className="ml-auto text-gray-300 hover:text-red-600 disabled:opacity-50"
                    aria-label="Delete draft order"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (takeoff.lines.length === 0) {
    return (
      <div className="space-y-3">
        {ordersBlock}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
          <PackageSearch className="mx-auto h-5 w-5 text-gray-400" />
          <p className="mt-2 text-xs text-gray-500">
            Nothing to buy yet. Place plants, sod or heads on the map, or add
            parts, and the order list builds itself.
          </p>
        </div>
      </div>
    );
  }

  // Grouped for reading, but the grouping is presentational only — the contract
  // already returned them in order.
  const groups: { source: MaterialLine["source"]; lines: MaterialLine[] }[] = [];
  for (const line of takeoff.lines) {
    const last = groups[groups.length - 1];
    if (last && last.source === line.source) last.lines.push(line);
    else groups.push({ source: line.source, lines: [line] });
  }

  return (
    <div className="space-y-3">
      {ordersBlock}

      <p className="text-xs text-gray-500">
        What this job has to buy, from the quantities already on the estimate.
        Costs are yours, not the customer&apos;s price.
      </p>

      {warning && (
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
          <p className="text-[11px] leading-snug text-amber-900">{warning}</p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.source} className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            {SOURCE_LABEL[g.source]}
          </p>
          {g.lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white p-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-gray-900">{l.label}</p>
                {l.detail && (
                  <p className="text-[11px] text-gray-500">{l.detail}</p>
                )}
                {/* A line that cannot be ordered says so where it is read. */}
                {l.note && (
                  <p className="mt-1 text-[11px] leading-snug text-amber-800">
                    {l.note}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="text-xs font-semibold text-gray-900">
                  {l.orderable ? (
                    <>
                      {l.quantity} {UNIT_LABEL[l.unit]}
                    </>
                  ) : (
                    <span className="text-amber-700">—</span>
                  )}
                </p>
                {/* 0 is not free. An unpriced line says so instead of $0.00. */}
                <p className="text-[11px] text-gray-500">
                  {l.unpriced ? (
                    <span className="text-amber-700">no cost recorded</span>
                  ) : (
                    <>
                      {formatMoney(l.unitCost)}/{UNIT_LABEL[l.unit]} ·{" "}
                      {formatMoney(l.extendedCost)}
                    </>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      ))}

      {/*
        Sod is bought by the pallet, so a job nearly always pays for grass it
        does not lay. It is real money and it is invisible unless it is shown.
      */}
      {leftover > 0 && (
        <p className="text-[11px] text-gray-500">
          Includes {leftover.toLocaleString()} sq ft of sod bought and not laid —
          whole pallets only.
        </p>
      )}

      <div className="flex items-center justify-between border-t border-gray-200 pt-2">
        <span className="text-xs font-semibold text-gray-900">
          Material cost
        </span>
        <span className="text-sm font-semibold text-gray-900 tabular-nums">
          {formatMoney(takeoff.total)}
        </span>
      </div>
      {takeoff.unpricedCount > 0 && (
        <p className="text-[11px] text-amber-800">
          This total excludes {takeoff.unpricedCount} line
          {takeoff.unpricedCount === 1 ? "" : "s"} with no cost recorded. It is
          not the whole bill.
        </p>
      )}

      {/*
        Raising an order COPIES these lines. The list above is live and follows
        the estimate; an order does not, which is the entire point of having
        one. Everything that is about to be left off is said BEFORE the button,
        so the decision is made knowing it.
      */}
      {canEdit && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5 space-y-2">
          <p className="text-[11px] leading-snug text-gray-600">
            An order takes a copy of these lines. Editing the estimate afterwards
            will not change it.
          </p>
          {willExclude && (
            <p className="text-[11px] leading-snug text-amber-800">{willExclude}</p>
          )}
          <input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Supplier (optional)"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          />
          <button
            onClick={() => void raiseOrder()}
            disabled={busy || !!cannotOrder}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ClipboardList className="h-3.5 w-3.5" />
            )}
            Draft an order
          </button>
          {cannotOrder && (
            <p className="text-[11px] leading-snug text-amber-800">{cannotOrder}</p>
          )}
        </div>
      )}
    </div>
  );
}
