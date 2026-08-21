"use client";

import { useState } from "react";
import { Loader2, XCircle } from "lucide-react";

// Inline "why was this skipped" panel — a preset reason + optional note,
// combined into the single string the status API stores as skip_reason and
// renders into the customer's service_skipped notice ({{reason}}). Shaped
// "preset" or "preset: note" (never just a bare note — a preset is always
// present so office/customer skip lists stay scannable). Mirrors the
// inline-expand-in-place form pattern used by "Record payment" in
// InvoiceActions.tsx rather than a modal.
export const SKIP_REASON_PRESETS = [
  "Weather",
  "No access",
  "Customer request",
  "Equipment",
  "Other",
] as const;

export default function SkipReasonPicker({
  onConfirm,
  onCancel,
  busy,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [preset, setPreset] = useState<string>(SKIP_REASON_PRESETS[0]);
  const [note, setNote] = useState("");

  function confirm() {
    const trimmedNote = note.trim();
    onConfirm(trimmedNote ? `${preset}: ${trimmedNote}` : preset);
  }

  return (
    <div className="space-y-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
      <span className="text-sm font-medium text-gray-700">
        Why was this visit skipped?
      </span>
      <select
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
        disabled={busy}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50"
      >
        {SKIP_REASON_PRESETS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note (e.g. gate locked, dog in yard)"
        rows={2}
        disabled={busy}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:opacity-50"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="flex-1 bg-amber-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
          Confirm skip
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-2 rounded-lg font-semibold text-sm text-gray-600 bg-white border border-gray-300 active:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
