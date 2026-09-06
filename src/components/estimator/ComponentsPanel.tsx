"use client";

// Irrigation components panel (Lane C). Adds a system component — controller,
// zone valves, wire, mainline, trenching — to the estimate, writing
// estimate_components with a full snapshot AND the billable line item.
//
// The snapshot rule: store a copy, so re-pricing the catalogue never moves a
// quote already sent.
//
// Units are `each` or `foot`, and the line item carries PER-UNIT money —
// componentLineItem returns unit_price and internal_cost per unit, and the
// quote consumer multiplies by quantity. Handing it an extended figure would
// bill 200 ft of wire two hundred times over.
//
// Foot rows get the measured pipe footage fed in — the pipe panel's "pipe to
// buy" number is exactly the quantity a lateral or mainline row needs, so
// nobody retypes it (or retypes it wrong).

import { useState } from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  componentCharge,
  componentLineItem,
  componentSnapshot,
  type ComponentSnapshot,
  type IrrigationComponent,
} from "@/lib/irrigationSystem";

export type ComponentRow = {
  id: string;
  snapshot: ComponentSnapshot;
  quantity: number;
};

type Props = {
  components: IrrigationComponent[];
  rows: ComponentRow[];
  // The pipe panel's measured total (feet to buy), or null with no heads.
  pipeTotalFt: number | null;
  canEdit: boolean;
  saving: boolean;
  // The WORKSPACE derives and adds the billable line from this same call —
  // this panel holds the line only to gate the button and preview the charge.
  onAdd: (componentId: string, quantity: number) => void;
  onRemove: (rowId: string) => void;
};

export default function ComponentsPanel({
  components,
  rows,
  pipeTotalFt,
  canEdit,
  saving,
  onAdd,
  onRemove,
}: Props) {
  const [componentId, setComponentId] = useState("");
  const [qtyStr, setQtyStr] = useState("");

  const selected = components.find((c) => c.id === componentId) ?? null;
  const qty = Number(qtyStr);
  const qtyValid = qtyStr.trim() !== "" && Number.isFinite(qty) && qty > 0;

  const preview =
    selected && qtyValid
      ? componentCharge(componentSnapshot(selected), qty)
      : null;
  const line = preview ? componentLineItem(preview) : null;

  const commit = () => {
    if (!selected || !qtyValid || !preview) return;
    onAdd(selected.id, qty);
    setQtyStr("");
    setComponentId("");
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-xs text-gray-500">
          No components on this estimate yet. The pipe footage under Pipe is
          priced here, per foot.
        </p>
      )}

      {rows.map((row) => {
        const charge = componentCharge(row.snapshot, row.quantity);
        return (
          <div
            key={row.id}
            className="space-y-1 rounded border border-gray-200 bg-white p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900">
                {charge.name}
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
                <dt>Quantity</dt>
                <dd className="tabular-nums">{charge.basis}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Man-hours</dt>
                <dd className="tabular-nums">{charge.manHours}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Billed</dt>
                <dd className="tabular-nums">
                  {formatMoney(charge.revenue)} (cost {formatMoney(charge.cost)})
                </dd>
              </div>
            </dl>
            {charge.unpriced && (
              <p className="flex items-start gap-1 text-[11px] text-amber-700">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                Unpriced — no price recorded, which is not the same as free.
              </p>
            )}
          </div>
        );
      })}

      {components.length > 0 && (
        <div className="space-y-1.5 rounded border border-gray-200 bg-gray-50 p-2">
          <p className="text-xs font-medium text-gray-700">Add a component</p>
          <select
            aria-label="Component"
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
            value={componentId}
            onChange={(e) => {
              setComponentId(e.target.value);
              setQtyStr("");
            }}
            disabled={saving}
          >
            <option value="">Component…</option>
            {components.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.unit === "foot" ? "per ft" : "each"})
              </option>
            ))}
          </select>
          {selected && (
            <>
              <label className="block">
                <span className="text-[11px] font-medium text-gray-700">
                  Quantity — {selected.unit === "foot" ? "linear feet" : "pieces"}
                </span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={qtyStr}
                  onChange={(e) => setQtyStr(e.target.value)}
                  disabled={saving}
                  className={`mt-0.5 w-full rounded border px-2 py-1 text-xs ${
                    qtyStr.trim() === "" || qtyValid ? "border-gray-300" : "border-red-400"
                  }`}
                />
              </label>
              {selected.unit === "foot" && pipeTotalFt !== null && pipeTotalFt > 0 && (
                <button
                  type="button"
                  onClick={() => setQtyStr(String(pipeTotalFt))}
                  disabled={saving}
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
                >
                  Use measured pipe ({pipeTotalFt.toLocaleString(undefined, { maximumFractionDigits: 1 })} ft)
                </button>
              )}
              {preview && (
                <dl className="space-y-0.5 rounded border border-gray-200 bg-white p-1.5 text-[11px] text-gray-700">
                  <div className="flex justify-between gap-2">
                    <dt>Quantity</dt>
                    <dd className="tabular-nums">{preview.basis}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Billed</dt>
                    <dd className="tabular-nums">
                      {formatMoney(preview.revenue)} (cost {formatMoney(preview.cost)})
                    </dd>
                  </div>
                  {preview.unpriced && (
                    <div className="text-amber-700">
                      Unpriced — no price recorded, which is not the same as free.
                    </div>
                  )}
                </dl>
              )}
              <button
                type="button"
                disabled={!qtyValid || saving || !line}
                onClick={commit}
                className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="mx-auto h-3 w-3 animate-spin" />
                ) : !line ? (
                  "Unpriced — set a price in the catalogue to bill this"
                ) : (
                  "Add component to estimate"
                )}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}