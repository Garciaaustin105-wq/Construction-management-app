"use client";

// Equipment panel (Lane C). Machines are added to estimate_equipment with a
// quantity and a duration — DAYS for rented, HOURS for owned. The form asks
// for the right one based on ownership, because they are different quantities
// and a week of "5 days" on the wrong field is silence, not an error.
//
// Show the chosen PLAN, not just a total: charge.basis gives "1 week + 2
// days", which is what makes the number checkable and teaches that 5 days
// takes the week. Mobilization (delivery + pickup) is shown separately — it
// is once per machine per rental, not per day.

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  equipmentCharge,
  equipmentLineItem,
  equipmentTotals,
  rateAgeDays,
  type EquipmentLine,
  type EquipmentProduct,
} from "@/lib/equipmentProducts";
import type { EstimatorLine } from "./types";

export type EquipmentRow = {
  id: string;
  line: EquipmentLine;
  // The catalogue row's rate stamp, carried separately — the snapshot does
  // not hold it (the snapshot is what prices the quote; staleness is about
  // the catalogue, not the quote).
  ratesUpdatedAt: string | null;
};

type Props = {
  products: EquipmentProduct[];
  rows: EquipmentRow[];
  // Whether any labor exists on the estimate — plants, labor items or a
  // mobilization figure. Feeds the needsOperator warning.
  hasLabor: boolean;
  canEdit: boolean;
  saving: boolean;
  onAdd: (productId: string, quantity: number, hours: number, days: number) => void;
  onRemove: (rowId: string) => void;
  onAddLines: (lines: EstimatorLine[]) => void;
};

export default function EquipmentPanel({
  products,
  rows,
  hasLabor,
  canEdit,
  saving,
  onAdd,
  onRemove,
  onAddLines,
}: Props) {
  const [productId, setProductId] = useState("");
  const [qtyStr, setQtyStr] = useState("1");
  const [durStr, setDurStr] = useState("");

  const selected = products.find((p) => p.id === productId) ?? null;
  // The duration the form asks for follows ownership: days for rented,
  // hours for owned. They are different quantities on the same row.
  const durationUnit = selected?.ownership === "owned" ? "hours" : "days";

  const qty = Math.max(1, Math.floor(Number(qtyStr) || 1));
  const dur = Number(durStr);
  const durValid = durStr.trim() !== "" && Number.isFinite(dur) && dur > 0;
  const addReady = !!selected && durValid;

  const commitAdd = () => {
    if (!selected || !durValid) return;
    if (selected.ownership === "owned") onAdd(selected.id, qty, dur, 0);
    else onAdd(selected.id, qty, 0, dur);
    setDurStr("");
    setQtyStr("1");
  };

  const totals = equipmentTotals(rows.map((r) => r.line));
  // flatMap instead of a type predicate: the contract's line carries
  // internal_cost as a definite number, so a `(l) => l is EstimatorLine`
  // predicate is not assignable from it.
  const lineItems: EstimatorLine[] = totals.charges.flatMap((c) => {
    const line = equipmentLineItem(c);
    return line ? [line] : [];
  });

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-xs text-gray-500">
          No machines on this estimate yet.
        </p>
      )}

      {rows.map((row) => {
        const charge = equipmentCharge(row.line);
        const age = rateAgeDays({ rates_updated_at: row.ratesUpdatedAt });
        return (
          <div
            key={row.id}
            className="space-y-1 rounded border border-gray-200 bg-white p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900">
                {charge.quantity > 1 ? `${charge.quantity}× ` : ""}
                {charge.name}
                <span className="ml-1 font-normal text-gray-500">
                  · {charge.ownership}
                </span>
              </p>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${charge.name}`}
                  onClick={() => onRemove(row.id)}
                  disabled={saving}
                  className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <dl className="space-y-0.5 text-xs text-gray-700">
              <div className="flex justify-between gap-2">
                <dt>Basis</dt>
                <dd className="tabular-nums">{charge.basis}</dd>
              </div>
              {charge.mobilization > 0 && (
                <div className="flex justify-between gap-2 text-gray-500">
                  <dt>Mobilization (delivery + pickup, once)</dt>
                  <dd className="tabular-nums">{formatMoney(charge.mobilization)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt>Billed</dt>
                <dd className="tabular-nums">
                  {formatMoney(charge.revenue)} (cost {formatMoney(charge.cost)})
                </dd>
              </div>
              {age !== null && age > 90 && (
                <div className="text-amber-700">
                  Rates are {age} days old — rental pricing moves, check them.
                </div>
              )}
              {charge.unpriced && (
                <div className="text-amber-700">
                  {charge.ownership === "owned"
                    ? "No hourly cost set — this machine is quoting at zero."
                    : "No rental rates recorded — this machine is quoting at zero."}
                </div>
              )}
            </dl>
          </div>
        );
      })}

      {canEdit && products.length > 0 && (
        <div className="space-y-1.5 rounded border border-gray-200 bg-gray-50 p-2">
          <p className="text-xs font-medium text-gray-700">Add a machine</p>
          <select
            aria-label="Machine"
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              setDurStr("");
            }}
            disabled={saving}
          >
            <option value="">Machine…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.ownership})
              </option>
            ))}
          </select>
          {selected && (
            <div className="grid grid-cols-2 gap-1.5">
              <label>
                <span className="text-[11px] font-medium text-gray-700">Quantity</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={qtyStr}
                  onChange={(e) => setQtyStr(e.target.value)}
                  disabled={saving}
                  className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-xs"
                />
              </label>
              <label>
                <span className="text-[11px] font-medium text-gray-700">
                  {durationUnit === "hours" ? "Hours on the job" : "Days on the job"}
                </span>
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  inputMode="decimal"
                  value={durStr}
                  onChange={(e) => setDurStr(e.target.value)}
                  disabled={saving}
                  className={`mt-0.5 w-full rounded border px-2 py-1 text-xs ${
                    durStr.trim() === "" || durValid ? "border-gray-300" : "border-red-400"
                  }`}
                />
              </label>
            </div>
          )}
          {selected && selected.rates_updated_at === null && (
            <p className="text-[11px] text-amber-700">
              This machine has never been priced — every rate is blank.
            </p>
          )}
          <button
            type="button"
            disabled={!addReady || saving}
            onClick={commitAdd}
            className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "Add machine"}
          </button>
        </div>
      )}

      {/* Warnings */}
      {totals.unpricedCount > 0 && (
        <div className="rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          {totals.unpricedCount} machine{totals.unpricedCount === 1 ? " has" : "s have"} no cost
          recorded and {totals.unpricedCount === 1 ? "is" : "are"} quoting at zero — the job will look
          more profitable than it is.
        </div>
      )}
      {totals.needsOperator && !hasLabor && (
        <div className="rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          A machine here needs an operator and there is no labor on this estimate — nobody to run it.
        </div>
      )}

      {rows.length > 0 && (
        <button
          type="button"
          disabled={!canEdit || saving || lineItems.length === 0}
          onClick={() => onAddLines(lineItems)}
          className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="mx-auto h-3 w-3 animate-spin" />
          ) : lineItems.length === 0 ? (
            "Nothing billable — a price is missing"
          ) : (
            `Add equipment to estimate (${lineItems.length} ${lineItems.length === 1 ? "line" : "lines"})`
          )}
        </button>
      )}
    </div>
  );
}