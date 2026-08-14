"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Plus, Loader2, CalendarClock, Trash2 } from "lucide-react";

export type ScheduleEvent = {
  id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  kind: string;
  notes: string | null;
};

const KINDS = ["meeting", "inspection", "delivery", "milestone", "other"] as const;

export default function ScheduleEventsManager({
  jobId,
  initial,
  canEdit = false,
}: {
  jobId: string;
  initial: ScheduleEvent[];
  canEdit?: boolean;
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();

  const [events, setEvents] = useState<ScheduleEvent[]>(initial);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [kind, setKind] = useState<string>("meeting");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !start) {
      toast.warning("Title and start time are required");
      return;
    }
    setSaving(true);
    const startIso = new Date(start).toISOString();
    const endIso = end ? new Date(end).toISOString() : null;

    const { data, error } = await supabase
      .from("schedule_events")
      .insert({
        job_id: jobId,
        title: title.trim(),
        start_at: startIso,
        end_at: endIso,
        kind,
        notes: notes.trim() || null,
      })
      .select("id, title, start_at, end_at, kind, notes")
      .single();

    setSaving(false);
    if (error || !data) {
      toast.error(`Failed: ${error?.message ?? "no row returned"}`);
      return;
    }
    setEvents((prev) =>
      [...prev, data as ScheduleEvent].sort(
        (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
      )
    );
    setTitle("");
    setStart("");
    setEnd("");
    setKind("meeting");
    setNotes("");
    toast.success("Event added");
    router.refresh();
  }

  async function remove(id: string) {
    if (!customConfirm("Delete this schedule event?")) return;
    setBusyId(id);
    const { error } = await supabase.from("schedule_events").delete().eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setEvents((prev) => prev.filter((e) => e.id !== id));
    toast.success("Deleted");
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
        Schedule ({events.length})
      </h2>

      {canEdit && (
        <form
          onSubmit={add}
          className="bg-white rounded-lg p-3 shadow-sm space-y-2 mb-2"
        >
          <div className="flex items-center gap-1 text-sm font-medium text-gray-700">
            <Plus className="w-4 h-4" /> Add event
          </div>
          <input
            type="text"
            placeholder="Title (e.g. Pre-drywall inspection)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-gray-500">Start</span>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
                className="mt-0.5 w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">End (optional)</span>
              <input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-0.5 w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
          </div>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            type="submit"
            disabled={saving}
            className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Add
          </button>
        </form>
      )}

      {events.length === 0 ? (
        <div className="bg-white rounded-lg py-6 text-center shadow-sm">
          <CalendarClock className="w-6 h-6 text-gray-300 mx-auto mb-1" />
          <p className="text-sm text-gray-500">No schedule events yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
          {events.map((ev) => (
            <div key={ev.id} className="p-3 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900 truncate">{ev.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {new Date(ev.start_at).toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  {ev.end_at
                    ? ` → ${new Date(ev.end_at).toLocaleString([], {
                        timeStyle: "short",
                      })}`
                    : ""}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                    {ev.kind}
                  </span>
                </div>
                {ev.notes && (
                  <p className="text-xs text-gray-600 mt-1">{ev.notes}</p>
                )}
              </div>
              {canEdit && (
                <button
                  onClick={() => remove(ev.id)}
                  disabled={busyId === ev.id}
                  className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
                  title="Delete"
                >
                  {busyId === ev.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}