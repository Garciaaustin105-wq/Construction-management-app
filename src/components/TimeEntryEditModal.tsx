"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { useRouter } from "next/navigation";
import { Pencil, Loader2, X } from "lucide-react";

type Job = { id: string; name: string };
type CostCode = { id: string; code: string; name: string };
type Entry = {
  id: string;
  // Nullable since the shift-clock migration — a null job_id is a SHIFT entry
  // (one clock-in covering a whole lawn route), not a missing value.
  job_id: string | null;
  cost_code_id: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  note: string | null;
};

// ISO -> value for <input type="datetime-local"> (local time, YYYY-MM-DDTHH:mm).
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

// Edit an existing time entry. Used on /time (office/PM edit any) and on
// /crew/time (crew edit own). RLS permits both; the caller decides whether to
// render it.
export default function TimeEntryEditModal({
  entry,
  jobs,
  costCodes,
  variant,
}: {
  entry: Entry;
  jobs: Job[];
  costCodes: CostCode[];
  variant: "construction" | "lawn";
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [jobId, setJobId] = useState(entry.job_id ?? "");
  const [costCodeId, setCostCodeId] = useState(entry.cost_code_id ?? "");
  const [clockIn, setClockIn] = useState(toLocalInput(entry.clock_in_at));
  const [clockOut, setClockOut] = useState(
    entry.clock_out_at ? toLocalInput(entry.clock_out_at) : ""
  );
  const [note, setNote] = useState(entry.note ?? "");
  const [busy, setBusy] = useState(false);

  const toast = useToast();
  const router = useRouter();

  function open() {
    // Re-seed from the entry each open in case the list refreshed underneath.
    setJobId(entry.job_id ?? "");
    setCostCodeId(entry.cost_code_id ?? "");
    setClockIn(toLocalInput(entry.clock_in_at));
    setClockOut(entry.clock_out_at ? toLocalInput(entry.clock_out_at) : "");
    setNote(entry.note ?? "");
    setIsOpen(true);
  }
  function close() {
    setIsOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (clockOut && new Date(clockOut) < new Date(clockIn)) {
      toast.error("Clock-out must be after clock-in");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("time_entries")
      .update({
        job_id: jobId || null,
        cost_code_id: costCodeId || null,
        clock_in_at: new Date(clockIn).toISOString(),
        clock_out_at: clockOut ? new Date(clockOut).toISOString() : null,
        note: note.trim() || null,
      })
      .eq("id", entry.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    router.refresh();
    close();
  }

  const inputCls =
    "mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base bg-white";

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="text-blue-600 hover:underline text-xs inline-flex items-center gap-1 flex-shrink-0"
      >
        <Pencil className="w-3.5 h-3.5" /> Edit
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
          onClick={close}
        >
          <div
            className="bg-white rounded-lg p-4 shadow-lg max-w-md w-full space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <h2 className="text-base font-semibold text-gray-900">Edit shift</h2>
              <button
                type="button"
                onClick={close}
                className="text-gray-400 hover:text-gray-700 p-1"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={submit} className="space-y-3">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Job</span>
                <select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  required
                  className={inputCls}
                >
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
                </select>
              </label>

              {variant === "construction" && (
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">
                    Cost code (optional)
                  </span>
                  <select
                    value={costCodeId}
                    onChange={(e) => setCostCodeId(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">No code</option>
                    {costCodes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} · {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Clock in</span>
                <input
                  type="datetime-local"
                  value={clockIn}
                  onChange={(e) => setClockIn(e.target.value)}
                  required
                  className={inputCls}
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Clock out (optional)
                </span>
                <input
                  type="datetime-local"
                  value={clockOut}
                  onChange={(e) => setClockOut(e.target.value)}
                  className={inputCls}
                />
                <span className="text-xs text-gray-500">
                  Leave blank if still on the clock.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Note (optional)
                </span>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className={inputCls}
                />
              </label>

              <button
                type="submit"
                disabled={busy}
                className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "Save"
                )}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}