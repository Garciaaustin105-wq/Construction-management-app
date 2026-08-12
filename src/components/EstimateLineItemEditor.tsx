"use client";

import { Plus, Trash2 } from "lucide-react";
import { formatMoney } from "@/lib/money";

export type EstimateLine = {
  cost_code_id: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
};

export type CostCodeOption = {
  id: string;
  code: string;
  name: string;
};

const UNITS = ["EA", "LF", "SF", "CF", "HR", "DAY", "LOT", "GAL", "TON", "%"];

export default function EstimateLineItemEditor({
  items,
  onChange,
  costCodes,
  disabled = false,
}: {
  items: EstimateLine[];
  onChange: (next: EstimateLine[]) => void;
  costCodes: CostCodeOption[];
  disabled?: boolean;
}) {
  function update(idx: number, patch: Partial<EstimateLine>) {
    onChange(items.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }

  function add() {
    onChange([
      ...items,
      { cost_code_id: null, description: "", quantity: 1, unit: "EA", unit_price: 0 },
    ]);
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  const total = items.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );

  return (
    <div className="space-y-2">
      {items.length === 0 && (
        <div className="text-center py-6 text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg">
          No line items yet. Tap &ldquo;Add line&rdquo; below.
        </div>
      )}

      {items.map((item, idx) => {
        const lineTotal = (item.quantity || 0) * (item.unit_price || 0);
        const selectedCode = costCodes.find((c) => c.id === item.cost_code_id);
        return (
          <div
            key={idx}
            className="bg-white border border-gray-200 rounded-lg p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">
                Line {idx + 1}
              </span>
              <button
                type="button"
                onClick={() => remove(idx)}
                disabled={disabled}
                className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-30"
                title="Remove line"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {/* Cost code — picking one auto-fills the description if blank */}
            <label className="block">
              <span className="text-xs text-gray-500">Cost code</span>
              <select
                value={item.cost_code_id ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  const code = id ? costCodes.find((c) => c.id === id) : null;
                  const patch: Partial<EstimateLine> = { cost_code_id: id };
                  // Auto-fill description from the code name only if the line's
                  // description is empty or matches the previously selected code's
                  // name (so we don't clobber a manually edited description).
                  if (code && (!item.description || item.description === selectedCode?.name)) {
                    patch.description = code.name;
                  }
                  update(idx, patch);
                }}
                disabled={disabled}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
              >
                <option value="">No code</option>
                {costCodes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </label>

            <input
              type="text"
              value={item.description}
              onChange={(e) => update(idx, { description: e.target.value })}
              disabled={disabled}
              placeholder="Description (e.g. Cat6 cable run, labor)"
              className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />

            <div className="grid grid-cols-4 gap-2">
              <label className="block">
                <span className="text-xs text-gray-500">Qty</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.quantity}
                  onChange={(e) =>
                    update(idx, { quantity: parseFloat(e.target.value) || 0 })
                  }
                  disabled={disabled}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Unit</span>
                <select
                  value={item.unit || ""}
                  onChange={(e) => update(idx, { unit: e.target.value })}
                  disabled={disabled}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">—</option>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Unit $</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.unit_price}
                  onChange={(e) =>
                    update(idx, { unit_price: parseFloat(e.target.value) || 0 })
                  }
                  disabled={disabled}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <div className="block">
                <span className="text-xs text-gray-500">Total</span>
                <div className="mt-1 px-2 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm font-semibold text-right">
                  {formatMoney(lineTotal)}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="w-full text-blue-600 bg-blue-50 border border-blue-200 py-2 rounded-lg text-sm font-semibold active:bg-blue-100 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        Add line
      </button>

      {items.length > 0 && (
        <div className="bg-gray-900 text-white rounded-lg p-4 flex items-center justify-between">
          <span className="text-sm font-medium">Estimate total</span>
          <span className="text-lg font-bold">{formatMoney(total)}</span>
        </div>
      )}
    </div>
  );
}