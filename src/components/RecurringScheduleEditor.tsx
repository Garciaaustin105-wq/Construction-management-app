"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Spinner } from "@/components/Skeleton";
import { Pencil, Save, X } from "lucide-react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVAL_BY_FREQUENCY = { weekly: 1, biweekly: 2, monthly: 4 };

interface RecurringScheduleEditorProps {
  scheduleId: string;
  initial: {
    frequency: "weekly" | "biweekly" | "monthly";
    interval_weeks: number;
    days_of_week: number[];
    day_of_month: number | null;
    start_date: string;
    end_date: string | null;
    service_type: string | null;
    price_per_visit: number;
    notes: string | null;
  };
  lawnServices: { id: string; name: string; default_price: number }[];
  canEdit: boolean;
  onSaved?: (patch: {
    frequency: string;
    interval_weeks: number;
    days_of_week: number[];
    day_of_month: number | null;
    start_date: string;
    end_date: string | null;
    service_type: string | null;
    price_per_visit: number;
    notes: string | null;
  }) => void;
}

const RecurringScheduleEditor: React.FC<RecurringScheduleEditorProps> = ({
  scheduleId,
  initial,
  lawnServices,
  canEdit,
  onSaved,
}) => {
  const toast = useToast();

  const [frequency, setFrequency] = useState(initial.frequency);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(initial.days_of_week ?? []);
  const [dayOfMonth, setDayOfMonth] = useState<string>(
    initial.day_of_month ? String(initial.day_of_month) : ""
  );
  const [seasonStart, setSeasonStart] = useState<string>(initial.start_date ?? "");
  const [seasonEnd, setSeasonEnd] = useState<string>(initial.end_date ?? "");
  const [servicePick, setServicePick] = useState<string>(() => {
    const svc = lawnServices.find((s) => s.name === initial.service_type);
    return svc ? svc.id : "custom";
  });
  const [customService, setCustomService] = useState<string>(
    initial.service_type ?? ""
  );
  const [pricePerVisit, setPricePerVisit] = useState<string>(
    String(initial.price_per_visit ?? 0)
  );
  const [notes, setNotes] = useState<string>(initial.notes ?? "");
  const [editing, setEditing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);

  const toggleDay = (d: number) => {
    if (daysOfWeek.includes(d)) {
      setDaysOfWeek(daysOfWeek.filter((day) => day !== d));
    } else {
      setDaysOfWeek([...daysOfWeek, d]);
    }
  };

  const onServicePick = (value: string) => {
    setServicePick(value);
    if (value === "custom") {
      setCustomService("");
    } else {
      const svc = lawnServices.find((s) => s.id === value);
      if (svc) {
        setCustomService(svc.name);
        setPricePerVisit(String(svc.default_price ?? 0));
      }
    }
  };

  const resolvedServiceType = (): string | null => {
    return customService.trim() || null;
  };

  const validate = (): string | null => {
    if (!seasonStart.trim()) {
      return "Pick a season start date";
    }
    if (frequency !== "monthly" && daysOfWeek.length === 0) {
      return "Pick at least one weekday";
    }
    if (frequency === "monthly") {
      const dom = parseInt(dayOfMonth, 10);
      if (!dom || dom < 1 || dom > 28) {
        return "Day of month must be 1-28";
      }
    }
    if (!resolvedServiceType()) {
      return "Pick or type a service";
    }
    const price = parseFloat(pricePerVisit);
    if (isNaN(price) || price < 0) {
      return "Price per visit must be 0 or more";
    }
    return null;
  };

  const save = async () => {
    const vErr = validate();
    if (vErr) {
      toast.warning(vErr);
      return;
    }
    setSaving(true);
    const patch = {
      frequency,
      interval_weeks: INTERVAL_BY_FREQUENCY[frequency] ?? 1,
      days_of_week: frequency === "monthly" ? [] : daysOfWeek,
      day_of_month: frequency === "monthly" ? parseInt(dayOfMonth, 10) : null,
      start_date: seasonStart,
      end_date: seasonEnd.trim() || null,
      service_type: resolvedServiceType(),
      price_per_visit: parseFloat(pricePerVisit) || 0,
      notes: notes.trim() || null,
    };
    const supabase = createClient();
    const { error } = await supabase
      .from("recurring_schedules")
      .update(patch)
      .eq("id", scheduleId);
    setSaving(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Schedule updated");
      setEditing(false);
      onSaved?.(patch);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      {!editing ? (
        <div>
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-medium text-gray-900">Schedule</h2>
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-blue-600 font-medium flex items-center gap-1"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
            )}
          </div>
          <dl className="mt-4 space-y-4">
            <div>
              <dt className="text-sm font-medium text-gray-700">Frequency</dt>
              <dd className="text-base text-gray-900 capitalize">
                {frequency}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-700">Mow days</dt>
              <dd className="text-base text-gray-900">
                {frequency === "monthly"
                  ? `Day ${dayOfMonth}`
                  : daysOfWeek.map((d) => WEEKDAYS[d]).join(", ")}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-700">Season</dt>
              <dd className="text-base text-gray-900">
                {seasonStart} – {seasonEnd || "ongoing"}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-700">Service</dt>
              <dd className="text-base text-gray-900">
                {customService || "-"}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-700">Price per visit</dt>
              <dd className="text-base text-gray-900">
                {`$${parseFloat(pricePerVisit || "0").toFixed(2)}`}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-700">Notes</dt>
              <dd className="text-base text-gray-900">
                {notes || "-"}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-medium text-gray-900">Edit schedule</h2>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-gray-500 font-medium flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          </div>
          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Frequency *</span>
              <select
                value={frequency}
                onChange={(e) =>
                  setFrequency(
                    e.target.value as "weekly" | "biweekly" | "monthly"
                  )
                }
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>

            {frequency === "monthly" ? (
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Day of month (1-28) *
                </span>
                <input
                  type="number"
                  min="1"
                  max="28"
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              </label>
            ) : (
              <div>
                <span className="text-sm font-medium text-gray-700">
                  Weekdays *
                </span>
                <div className="mt-2 grid grid-cols-7 gap-2">
                {WEEKDAYS.map((day, index) => (
                  <button
                    key={index}
                    onClick={() => toggleDay(index)}
                    className={`${
                      daysOfWeek.includes(index)
                        ? "bg-green-600 text-white"
                        : "bg-gray-200 text-gray-900"
                    } py-2 rounded-lg text-sm font-semibold flex items-center justify-center`}
                  >
                    {day}
                  </button>
                ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Season start *
                </span>
                <input
                  type="date"
                  value={seasonStart}
                  onChange={(e) => setSeasonStart(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Season end
                </span>
                <input
                  type="date"
                  value={seasonEnd}
                  onChange={(e) => setSeasonEnd(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Service *</span>
              <select
                value={servicePick}
                onChange={(e) => onServicePick(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                {lawnServices.map((svc) => (
                  <option key={svc.id} value={svc.id}>
                    {svc.name}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>

            {servicePick === "custom" && (
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Custom service name
                </span>
                <input
                  type="text"
                  value={customService}
                  onChange={(e) => setCustomService(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              </label>
            )}

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Price per visit *
              </span>
              <input
                type="number"
                step="0.01"
                value={pricePerVisit}
                onChange={(e) => setPricePerVisit(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="mt-6 w-full bg-green-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {saving ? (
              <>
                <Spinner className="w-4 h-4" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save
              </>
            )}
          </button>
        </form>
      )}
    </div>
  );
};

export default RecurringScheduleEditor;