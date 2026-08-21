"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Loader2, X, Save } from "lucide-react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Cross-customer bulk edit for /lawn/jobs — applies a recurrence/price change
// to every schedule in the current checkbox selection via
// /api/lawn/schedules/bulk-edit. Each field has its own "change this?"
// checkbox so an unchecked field is OMITTED from the request body entirely
// (not sent as false/empty) — the API only patches what's present, so e.g.
// checking just "mow days" never touches price. Paused schedules in the
// selection are skipped server-side and reported back, not silently ignored.
export default function BulkScheduleEditModal({
  scheduleIds,
  onClose,
  onDone,
}: {
  scheduleIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [changeFrequency, setChangeFrequency] = useState(false);
  const [frequency, setFrequency] = useState<"weekly" | "biweekly" | "monthly">(
    "weekly"
  );
  const [changeDays, setChangeDays] = useState(false);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [changeDayOfMonth, setChangeDayOfMonth] = useState(false);
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [changePrice, setChangePrice] = useState(false);
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleDay(d: number) {
    setDaysOfWeek((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  }

  const anyChange =
    changeFrequency || changeDays || changeDayOfMonth || changePrice;

  async function save() {
    if (!anyChange) {
      toast.warning("Pick at least one field to change");
      return;
    }
    if (changeDays && daysOfWeek.length === 0) {
      toast.warning("Pick at least one mow day, or uncheck 'Change mow days'");
      return;
    }
    const body: Record<string, unknown> = { schedule_ids: scheduleIds };
    if (changeFrequency) body.frequency = frequency;
    if (changeDays) body.days_of_week = daysOfWeek;
    if (changeDayOfMonth) {
      const n = Number(dayOfMonth);
      if (!Number.isFinite(n) || n < 1 || n > 28) {
        toast.error("Day of month must be 1-28");
        return;
      }
      body.day_of_month = n;
    }
    if (changePrice) {
      const p = Number(price);
      if (!Number.isFinite(p) || p < 0) {
        toast.error("Enter a valid price");
        return;
      }
      body.price_per_visit = p;
    }

    setSaving(true);
    let res: Response;
    try {
      res = await fetch("/api/lawn/schedules/bulk-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setSaving(false);
      toast.error("Failed: network error");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      schedules_updated?: number;
      skipped_inactive?: number;
      visits_generated?: number;
      error?: string;
    };
    setSaving(false);
    if (!res.ok) {
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    const updated = data.schedules_updated ?? 0;
    const skipped = data.skipped_inactive ?? 0;
    const generated = data.visits_generated ?? 0;
    toast.success(
      `Updated ${updated} schedule${updated === 1 ? "" : "s"}` +
        (skipped > 0 ? ` · ${skipped} paused (skipped)` : "") +
        ` · ${generated} upcoming visit${generated === 1 ? "" : "s"} regenerated`
    );
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end lg:items-center justify-center">
      <div className="bg-white w-full lg:max-w-md lg:rounded-lg rounded-t-2xl p-4 space-y-3 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            Bulk edit {scheduleIds.length} schedule
            {scheduleIds.length === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-gray-400 p-1 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Only checked fields change. Upcoming pending visits are regenerated
          from today; done/skipped history is kept. Paused schedules are
          skipped.
        </p>

        <div className="space-y-2 border-t border-gray-100 pt-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={changeFrequency}
              onChange={(e) => setChangeFrequency(e.target.checked)}
              disabled={saving}
            />
            Change frequency
          </label>
          {changeFrequency && (
            <select
              value={frequency}
              onChange={(e) =>
                setFrequency(
                  e.target.value as "weekly" | "biweekly" | "monthly"
                )
              }
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          )}
        </div>

        <div className="space-y-2 border-t border-gray-100 pt-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={changeDays}
              onChange={(e) => setChangeDays(e.target.checked)}
              disabled={saving}
            />
            Change mow days
          </label>
          {changeDays && (
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((label, d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  disabled={saving}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50 ${
                    daysOfWeek.includes(d)
                      ? "bg-green-600 text-white border-green-600"
                      : "bg-white text-gray-600 border-gray-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-gray-100 pt-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={changeDayOfMonth}
              onChange={(e) => setChangeDayOfMonth(e.target.checked)}
              disabled={saving}
            />
            Change day of month (monthly only)
          </label>
          {changeDayOfMonth && (
            <input
              type="number"
              min="1"
              max="28"
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          )}
        </div>

        <div className="space-y-2 border-t border-gray-100 pt-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input
              type="checkbox"
              checked={changePrice}
              onChange={(e) => setChangePrice(e.target.checked)}
              disabled={saving}
            />
            Change price per visit
          </label>
          {changePrice && (
            <input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={save}
            disabled={saving || !anyChange}
            className="flex-1 bg-green-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Apply to {scheduleIds.length}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 rounded-lg font-semibold text-sm text-gray-600 bg-white border border-gray-300 active:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
