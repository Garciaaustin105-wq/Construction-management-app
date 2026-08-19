"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { useRouter } from "next/navigation";
import { Plus, Loader2, X } from "lucide-react";

type Worker = { id: string; full_name: string | null };
type Job = { id: string; name: string };
type CostCode = { id: string; code: string; name: string };

// Office/PM action on the /time overview: add a past (or still-open) shift on
// behalf of a crew member. Insert goes straight through RLS (`office time_all`
// permits office/admin/PM/super_admin to insert any row in their org).
export default function ManualTimeEntryForm({
  workers,
  jobs,
  costCodes,
  variant,
}: {
  workers: Worker[];
  jobs: Job[];
  costCodes: CostCode[];
  variant: "construction" | "lawn";
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [workerId, setWorkerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const toast = useToast();
  const router = useRouter();
  const supabase = createClient();

  function close() {
    setIsOpen(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workerId || !jobId || !clockIn) {
      toast.error("Worker, job, and clock-in are required");
      return;
    }
    if (clockOut && new Date(clockOut) < new Date(clockIn)) {
      toast.error("Clock-out must be after clock-in");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("time_entries").insert({
      user_id: workerId,
      job_id: jobId,
      cost_code_id: costCodeId || null,
      clock_in_at: new Date(clockIn).toISOString(),
      clock_out_at: clockOut ? new Date(clockOut).toISOString() : null,
      note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Shift added");
    router.refresh();
    setWorkerId("");
    setJobId("");
    setCostCodeId("");
    setClockIn("");
    setClockOut("");
    setNote("");
    close();
  }

  const inputCls =
    "mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base bg-white";

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="w-full bg-white border border-gray-300 text-gray-900 text-center py-2.5 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        Add shift
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
              <h2 className="text-base font-semibold text-gray-900">Add shift</h2>
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
                <span className="text-sm font-medium text-gray-700">Worker</span>
                <select
                  value={workerId}
                  onChange={(e) => setWorkerId(e.target.value)}
                  required
                  className={inputCls}
                >
                  <option value="">Select worker</option>
                  {workers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.full_name ?? "Unknown"}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Job</span>
                <select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  required
                  className={inputCls}
                >
                  <option value="">Select job</option>
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
                  Leave blank if they&rsquo;re still on the clock.
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
                  placeholder="What were they working on?"
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
                  <Plus className="w-4 h-4" />
                )}
                Add shift
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}