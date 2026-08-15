"use client";

import { Plus, Trash2 } from "lucide-react";
import { formatMoney, type LineItem } from "@/lib/money";
import NumberInput from "@/components/NumberInput";

export type { LineItem };

// A lawn-services catalog entry offered as a line-item quick-pick (only passed
// when invoicing a lawn job — see NewInvoiceForm). Picking one appends a line
// pre-filled with the service name + default price so the user doesn't retype.
export type ServiceOption = {
  id: string;
  name: string;
  default_price: number;
};

export default function LineItemEditor({
  items,
  onChange,
  disabled = false,
  services,
}: {
  items: LineItem[];
  onChange: (next: LineItem[]) => void;
  disabled?: boolean;
  services?: ServiceOption[];
}) {
  function update(idx: number, patch: Partial<LineItem>) {
    onChange(
      items.map((item, i) => (i === idx ? { ...item, ...patch } : item))
    );
  }

  function add() {
    onChange([...items, { description: "", quantity: 1, unit_price: 0 }]);
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  // "Add from service catalog" — appends a line from a lawn_services row, then
  // resets the select so the same service can be picked again. Free-text lines
  // are still available via the "Add line" button.
  function addFromCatalog(svcId: string) {
    const svc = services?.find((s) => s.id === svcId);
    if (!svc) return;
    onChange([
      ...items,
      { description: svc.name, quantity: 1, unit_price: svc.default_price },
    ]);
  }

  const total = items.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );

  return (
    <div className="space-y-2">
      {services && services.length > 0 && (
        <label className="block">
          <span className="text-xs text-gray-500">Add from service catalog</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addFromCatalog(e.target.value);
              e.target.value = "";
            }}
            disabled={disabled}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white disabled:opacity-50"
          >
            <option value="">Pick a service to add a line…</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {items.length === 0 && (
        <div className="text-center py-6 text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg">
          No line items. Tap &ldquo;Add line&rdquo; below.
        </div>
      )}

      {items.map((item, idx) => {
        const lineTotal = (item.quantity || 0) * (item.unit_price || 0);
        return (
          <div
            key={idx}
            className="bg-white border border-gray-200 rounded-lg p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">
                Item {idx + 1}
              </span>
              <button
                type="button"
                onClick={() => remove(idx)}
                disabled={disabled}
                className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-30"
                title="Remove item"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <input
              type="text"
              value={item.description}
              onChange={(e) => update(idx, { description: e.target.value })}
              disabled={disabled}
              placeholder="Description (e.g. Cat6 cable, labor hour)"
              className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="text-xs text-gray-500">Qty</span>
                <NumberInput
                  value={item.quantity}
                  onChange={(n) => update(idx, { quantity: n })}
                  disabled={disabled}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Unit price</span>
                <NumberInput
                  value={item.unit_price}
                  onChange={(n) => update(idx, { unit_price: n })}
                  disabled={disabled}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <div className="block">
                <span className="text-xs text-gray-500">Line total</span>
                <div className="mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm font-semibold text-right">
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
          <span className="text-sm font-medium">Total</span>
          <span className="text-lg font-bold">{formatMoney(total)}</span>
        </div>
      )}
    </div>
  );
}