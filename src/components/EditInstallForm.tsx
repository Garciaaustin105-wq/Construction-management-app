"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Ban, RotateCcw } from "lucide-react";

type Opt = { id: string; name: string };
type CrewOpt = { id: string; full_name: string | null; email: string; role: string };
type Install = {
  id: string;
  job_id: string | null;
  customer_id: string | null;
  install_type_id: string | null;
  title: string;
  status: string;
  price: number | string | null;
  address: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  assigned_crew: string[] | null;
  notes: string | null;
};

// `datetime-local` wants "YYYY-MM-DDTHH:mm" in LOCAL time, but the column is a
// timestamptz that arrives as UTC ISO. Converting via the local getters (rather
// than slicing the ISO string) is what keeps a 9am appointment showing as 9am
// instead of jumping by the timezone offset — the exact bug a naive
// `.slice(0,16)` introduces.
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export default function EditInstallForm({
  install,
  installTypes,
  customers,
  jobs,
  crew,
}: {
  install: Install;
  installTypes: Opt[];
  customers: Opt[];
  jobs: Opt[];
  crew: CrewOpt[];
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  const [title, setTitle] = useState(install.title);
  const [typeId, setTypeId] = useState(install.install_type_id ?? "");
  const [customerId, setCustomerId] = useState(install.customer_id ?? "");
  const [jobId, setJobId] = useState(install.job_id ?? "");
  const [address, setAddress] = useState(install.address ?? "");
  const [price, setPrice] = useState(
    install.price == null ? "" : String(Number(install.price))
  );
  const [scheduledAt, setScheduledAt] = useState(
    toLocalInputValue(install.scheduled_at)
  );
  const [duration, setDuration] = useState(
    install.duration_minutes == null ? "" : String(install.duration_minutes)
  );
  const [assigned, setAssigned] = useState<string[]>(install.assigned_crew ?? []);
  const [notes, setNotes] = useState(install.notes ?? "");
  const [saving, setSaving] = useState(false);

  const isCancelled = install.status === "cancelled";
  const isFinished =
    install.status === "completed" || install.status === "needs_followup";

  function toggleCrew(id: string) {
    setAssigned((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    if (!title.trim()) {
      toast.error("Give the install a title");
      return;
    }
    const priceNum = price.trim() === "" ? 0 : Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Price must be a number, 0 or more");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("installs")
      .update({
        title: title.trim(),
        install_type_id: typeId || null,
        customer_id: customerId || null,
        job_id: jobId || null,
        address: address.trim() || null,
        price: priceNum,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        duration_minutes: duration.trim() === "" ? null : Number(duration),
        assigned_crew: assigned,
        notes: notes.trim() || null,
      })
      .eq("id", install.id);

    if (error) {
      toast.error(`Failed: ${error.message}`);
      setSaving(false);
      return;
    }
    toast.success("Install updated");
    router.push(`/installs/${install.id}`);
    router.refresh();
  }

  // Status changes are kept to three deliberate transitions rather than a free
  // status dropdown, so the office can't leave an install in a state the field
  // flow can't reason about (e.g. "completed" with no outcome and no end time).
  async function setStatus(
    next: "cancelled" | "scheduled",
    successMsg: string,
    clearCompletion: boolean
  ) {
    setSaving(true);
    const patch: Record<string, unknown> = { status: next };
    if (clearCompletion) {
      patch.completion_outcome = null;
      patch.completed_at = null;
    }
    const { error } = await supabase
      .from("installs")
      .update(patch)
      .eq("id", install.id);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success(successMsg);
      router.push(`/installs/${install.id}`);
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Title *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Install type</span>
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {installTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Customer</span>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Attached job</span>
          <select
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">— standalone install —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Address</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Price</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Scheduled for</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Expected duration (minutes)
          </span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Assigned crew</h2>
        <p className="text-xs text-gray-500 mb-3">
          Removing someone hides the install from them and stops them recording
          any more work on it. Time and notes they already logged are kept.
        </p>
        <div className="space-y-2">
          {crew.map((c) => (
            <label
              key={c.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 active:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={assigned.includes(c.id)}
                onChange={() => toggleCrew(c.id)}
                className="w-5 h-5"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {c.full_name ?? c.email}
                </p>
                <p className="text-xs text-gray-500 truncate">{c.email}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Office notes (crew can read, not edit)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save changes"}
      </button>

      <section className="bg-white rounded-lg p-4 shadow-sm space-y-2">
        <h2 className="text-sm font-semibold text-gray-900">Status</h2>
        {isCancelled ? (
          <>
            <p className="text-xs text-gray-500">
              This install is cancelled. Crew can&apos;t see or act on it.
            </p>
            <button
              disabled={saving}
              onClick={() => setStatus("scheduled", "Install restored", true)}
              className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50 disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" /> Restore to scheduled
            </button>
          </>
        ) : (
          <>
            {isFinished && (
              <button
                disabled={saving}
                onClick={() =>
                  setStatus("scheduled", "Reopened for another visit", true)
                }
                className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50 disabled:opacity-50"
              >
                <RotateCcw className="w-4 h-4" /> Reopen for another visit
              </button>
            )}
            <p className="text-xs text-gray-500">
              Cancelling keeps the record and its history, but hides it from the
              crew and the calendar.
            </p>
            <button
              disabled={saving}
              onClick={() => setStatus("cancelled", "Install cancelled", false)}
              className="w-full flex items-center justify-center gap-2 border border-red-200 text-red-700 py-3 rounded-lg font-medium active:bg-red-50 disabled:opacity-50"
            >
              <Ban className="w-4 h-4" /> Cancel this install
            </button>
          </>
        )}
      </section>
    </div>
  );
}
