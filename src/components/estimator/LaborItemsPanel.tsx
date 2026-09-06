"use client";

// Labor items panel (Lane C). Adds a non-catalogue-scope labor line — mulch,
// bed prep, grading, demolition — to the estimate, writing
// estimate_labor_items with a full snapshot AND the billable line item.
//
// The snapshot rule: store a copy, so re-pricing the catalogue never moves a
// quote already sent.
//
// UNITS ARE THE WHOLE GAME here:
//  - Every quantity input is labeled with the item's unit. `basis` on the
//    charge already names it; the input names it too.
//  - msqft is per THOUSAND square feet. Nobody types thousands: measured area
//    is fed through toMsqft(sqft). Typing 5000 into an MSF field is a
//    thousand-fold error that looks perfectly correct.
//  - An hour row's quantity IS the man-hours; install_minutes is ignored on
//    it, deliberately.
//  - install_minutes is NUMERIC — per-foot and per-area rates are fractional.
//
// TWO KINDS OF BLANK, surfaced separately (state-of-play §2.2):
//  - unpriced — no price recorded. NOT the same as free.
//  - untimed  — no man-minutes recorded. NOT the same as instant.
//
// An unpriced row cannot be billed (laborLineItem returns null), so the add
// is disabled rather than creating a $0 line. A priced-but-untimed row CAN be
// billed — the warning is shown, not a block.

import { useState } from "react";
import { Loader2, Trash2, TriangleAlert } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  laborCharge,
  laborLineItem,
  laborSnapshot,
  toMsqft,
  unitAbbrev,
  unitLabel,
  type LaborItem,
  type LaborSnapshot,
} from "@/lib/laborItems";

export type LaborRow = {
  id: string;
  snapshot: LaborSnapshot;
  quantity: number;
};

type Props = {
  items: LaborItem[];
  rows: LaborRow[];
  // Measured areas, for the MSF helper — nobody types thousands.
  areas: { id: string; name: string; area_sqft: number }[];
  canEdit: boolean;
  saving: boolean;
  // The WORKSPACE derives and adds the billable line from this same call —
  // this panel holds the line only to gate the button and preview the charge,
  // so both sides always price the same entry.
  onAdd: (itemId: string, quantity: number) => void;
  onRemove: (rowId: string) => void;
};

export default function LaborItemsPanel({
  items,
  rows,
  areas,
  canEdit,
  saving,
  onAdd,
  onRemove,
}: Props) {
  const [itemId, setItemId] = useState("");
  const [qtyStr, setQtyStr] = useState("");

  const selected = items.find((i) => i.id === itemId) ?? null;
  const qty = Number(qtyStr);
  const qtyValid = qtyStr.trim() !== "" && Number.isFinite(qty) && qty > 0;

  const preview = selected && qtyValid ? laborCharge(laborSnapshot(selected), qty) : null;
  const line = preview ? laborLineItem(preview) : null;

  const commit = () => {
    if (!selected || !qtyValid || !preview) return;
    onAdd(selected.id, qty);
    setQtyStr("");
    setItemId("");
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && items.length === 0 && (
        <p className="text-xs text-gray-500">
          No labor items in the catalogue yet — add them under Labor Items in the menu.
        </p>
      )}
      {rows.length === 0 && items.length > 0 && (
        <p className="text-xs text-gray-500">
          No labor lines on this estimate yet.
        </p>
      )}

      {rows.map((row) => {
        const charge = laborCharge(row.snapshot, row.quantity);
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
            {charge.untimed && (
              <p className="flex items-start gap-1 text-[11px] text-amber-700">
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                Untimed — no man-minutes recorded, which is not the same as instant.
              </p>
            )}
          </div>
        );
      })}

      {items.length > 0 && (
        <div className="space-y-1.5 rounded border border-gray-200 bg-gray-50 p-2">
          <p className="text-xs font-medium text-gray-700">Add a labor line</p>
          <select
            aria-label="Labor item"
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              setQtyStr("");
            }}
            disabled={saving}
          >
            <option value="">Item…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({unitAbbrev(i.unit)})
              </option>
            ))}
          </select>
          {selected && (
            <>
              <label className="block">
                <span className="text-[11px] font-medium text-gray-700">
                  Quantity — {unitLabel(selected.unit)}
                  {selected.unit === "hour" && " (the quantity IS the man-hours)"}
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
              {selected.unit === "msqft" && areas.length > 0 && (
                <label className="block">
                  <span className="text-[11px] text-gray-500">
                    …or fill from a measured area (converted to MSF for you):
                  </span>
                  <select
                    aria-label="Fill quantity from a measured area"
                    className="mt-0.5 w-full rounded border border-gray-300 px-2 py-1 text-xs"
                    value=""
                    onChange={(e) => {
                      const area = areas.find((a) => a.id === e.target.value);
                      if (area && area.area_sqft > 0) setQtyStr(String(toMsqft(area.area_sqft)));
                    }}
                    disabled={saving}
                  >
                    <option value="">Use a measured area…</option>
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.area_sqft.toLocaleString(undefined, { maximumFractionDigits: 0 })} sq
                        ft → {toMsqft(a.area_sqft)} MSF)
                      </option>
                    ))}
                  </select>
                </label>
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
                  {preview.untimed && (
                    <div className="text-amber-700">
                      Untimed — no man-minutes recorded, which is not the same as instant.
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
                  "Add labor item to estimate"
                )}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}