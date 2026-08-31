"use client";

// The overdue backlog list. Pending lawn visits with a due date before the
// org's "today", oldest first, each showing the date it was ACTUALLY due and
// how many days late it is — an overdue visit with no original date is just a
// visit you cannot plan around.
//
// Every completing/skipping action goes through POST /api/lawn/visits/[id]/
// status — the route is what sends the customer's notice; a direct
// lawn_visits.update({status:...}) silently skips it (a mistake made before).
// Mark-done ALWAYS confirms first because it emails the customer, and is
// deliberately never offered as a bulk action. Reschedule and skip may bulk.
//
// "Today" comes from the org zone via todayInZone — never toISOString().

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import EmptyState from "@/components/EmptyState";
import { todayInZone, lateLabel, formatDueStamp } from "@/lib/orgDate";
import { Loader2, Inbox, CalendarClock, CalendarOff, Check } from "lucide-react";

type Row = {
  id: string;
  due_date: string;
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
  } | null;
};

export default function OverdueManager({ timeZone }: { timeZone: string }) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [today, setToday] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Inline reschedule editor (one row at a time).
  const [reschedId, setReschedId] = useState<string | null>(null);
  const [reschedDate, setReschedDate] = useState("");
  // Inline skip editor (one row at a time) — reason is REQUIRED.
  const [skipId, setSkipId] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState("");
  // Bulk bar inputs (reschedule date + shared skip reason).
  const [bulkDate, setBulkDate] = useState("");
  const [bulkReason, setBulkReason] = useState("");

  const load = useCallback(async () => {
    // Org-zone today, computed at fetch time (deterministic for the zone —
    // same answer the server pages get from todayInZone, no UTC anywhere).
    const t = todayInZone(timeZone);
    setToday(t);
    // RLS scopes this to the org — no manual organization_id filter.
    const { data } = await supabase
      .from("lawn_visits")
      .select("id, due_date, jobs(name, address, customers(name))")
      .eq("status", "pending")
      .lt("due_date", t)
      .order("due_date", { ascending: true });
    setRows((data as unknown as Row[] | null) ?? []);
    setSelected(new Set());
    setReschedId(null);
    setSkipId(null);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The one path that may complete/skip/move a visit from here: the status
  // route, which is what decides whether the customer hears about it.
  // Returns the response body (with `notified`) or null on failure.
  async function post(
    id: string,
    body: Record<string, unknown>
  ): Promise<{ notified?: boolean } | null> {
    const res = await fetch(`/api/lawn/visits/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(err?.error ?? `Failed (${res.status})`);
      return null;
    }
    return (await res.json().catch(() => null)) as { notified?: boolean } | null;
  }

  async function markDone(r: Row) {
    const who = r.jobs?.customers?.name ?? r.jobs?.name ?? "the customer";
    if (!confirm(`Mark \"${r.jobs?.name ?? "this visit"}\" as done? This emails ${who} that the visit was completed — it is not just bookkeeping.`)) {
      return;
    }
    setBusyId(r.id);
    try {
      const body = await post(r.id, { status: "done" });
      if (body) {
        toast.success(body.notified ? "Done — customer notified" : "Marked done");
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function skipRow(id: string) {
    const reason = skipReason.trim();
    if (!reason) {
      toast.error("A reason is required — a skip without one is indistinguishable from forgetting.");
      return;
    }
    setBusyId(id);
    try {
      const body = await post(id, { status: "skipped", skip_reason: reason });
      if (body) {
        toast.success(body.notified ? "Skipped — customer notified" : "Skipped");
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  async function rescheduleRow(id: string) {
    if (!reschedDate) {
      toast.error("Pick a new date first.");
      return;
    }
    setBusyId(id);
    try {
      const body = await post(id, { due_date: reschedDate });
      if (body) {
        toast.success(`Rescheduled to ${formatDueStamp(reschedDate)}`);
      }
    } finally {
      setBusyId(null);
      await load();
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulk(action: "reschedule" | "skip") {
    const ids = [...selected];
    if (action === "reschedule" && !bulkDate) {
      toast.error("Pick a new date first.");
      return;
    }
    const reason = bulkReason.trim();
    if (action === "skip" && !reason) {
      toast.error("A reason is required — a skip without one is indistinguishable from forgetting.");
      return;
    }
    const verb = action === "reschedule" ? "Reschedule" : "Skip";
    if (!confirm(`${verb} ${ids.length} visit${ids.length === 1 ? "" : "s"}?`)) return;
    setBulkBusy(true);
    try {
      let okCount = 0;
      for (const id of ids) {
        const body =
          action === "reschedule"
            ? await post(id, { due_date: bulkDate })
            : await post(id, { status: "skipped", skip_reason: reason });
        if (body) okCount++;
      }
      if (okCount === ids.length) {
        toast.success(`${verb === "Reschedule" ? "Rescheduled" : "Skipped"} all ${ids.length}${action === "skip" ? " — customers notified" : ""}`);
      } else {
        toast.error(`Done for ${okCount} of ${ids.length} — ${ids.length - okCount} failed`);
      }
    } finally {
      setBulkBusy(false);
      await load();
    }
  }

  if (!ready) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-7 h-7 animate-spin text-gray-400" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nothing overdue"
        description="Pending visits that slip past their due date land here, oldest first, so the office catches them instead of the customer."
      />
    );
  }

  return (
    <section className="space-y-3">
      {/* The count is the point — this is a backlog the office should feel. */}
      <p className="text-xs text-gray-500">
        {rows.length} overdue visit{rows.length === 1 ? "" : "s"}. Reschedule or
        skip in bulk below; marking one done emails that customer, so it is
        always one at a time.
      </p>

      <div className="space-y-2">
        {rows.map((r) => {
          const late = lateLabel(r.due_date, today);
          const busy = busyId === r.id;
          const isOpenResched = reschedId === r.id;
          const isOpenSkip = skipId === r.id;
          const actionLocked = busyId !== null || bulkBusy;
          return (
            <div
              key={r.id}
              className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y divide-gray-100"
            >
              <div className="p-3 flex items-start gap-2.5">
                <input
                  type="checkbox"
                  aria-label={`Select ${r.jobs?.name ?? "visit"}`}
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-gray-900"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between items-start gap-2">
                    <p className="font-semibold text-gray-900 truncate">
                      {r.jobs?.name ?? "—"}
                    </p>
                    {/* The stamp + the lateness are the whole point of this
                        list — a red chip, not a quiet gray one. */}
                    <span className="flex-shrink-0 text-right">
                      <span className="block text-[10px] font-semibold px-2 py-0.5 rounded bg-red-100 text-red-800 whitespace-nowrap">
                        {formatDueStamp(r.due_date)}
                      </span>
                      {late && (
                        <span className="block text-[10px] text-red-700 mt-0.5 whitespace-nowrap">
                          {late}
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {r.jobs?.customers?.name ? `${r.jobs.customers.name} · ` : ""}
                    {r.jobs?.address ?? "—"}
                  </p>
                </div>
              </div>

              {isOpenResched && (
                <div className="p-3 pt-2.5 space-y-2">
                  <label className="block text-[11px] font-semibold text-gray-500">
                    New due date
                    <input
                      type="date"
                      min={today}
                      value={reschedDate}
                      onChange={(e) => setReschedDate(e.target.value)}
                      className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm text-gray-900"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => rescheduleRow(r.id)}
                      disabled={actionLocked}
                      className="flex-1 bg-gray-900 text-white py-2.5 rounded-lg text-sm font-semibold active:bg-gray-800 disabled:opacity-50"
                    >
                      Move to {reschedDate ? formatDueStamp(reschedDate) : "—"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setReschedId(null)}
                      disabled={actionLocked}
                      className="px-4 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold active:bg-gray-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {isOpenSkip && (
                <div className="p-3 pt-2.5 space-y-2">
                  <label className="block text-[11px] font-semibold text-gray-500">
                    Why is it being skipped? (required — the customer is told)
                    <textarea
                      value={skipReason}
                      onChange={(e) => setSkipReason(e.target.value)}
                      rows={2}
                      maxLength={500}
                      placeholder="e.g. Property for sale — owner asked us to hold service"
                      className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm text-gray-900"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => skipRow(r.id)}
                      disabled={actionLocked}
                      className="flex-1 bg-gray-900 text-white py-2.5 rounded-lg text-sm font-semibold active:bg-gray-800 disabled:opacity-50"
                    >
                      Skip — customer notified
                    </button>
                    <button
                      type="button"
                      onClick={() => setSkipId(null)}
                      disabled={actionLocked}
                      className="px-4 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold active:bg-gray-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {!isOpenResched && !isOpenSkip && (
                <div className="p-3 pt-2.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReschedId(r.id);
                      setReschedDate("");
                      setSkipId(null);
                    }}
                    disabled={actionLocked}
                    className="flex-1 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <CalendarClock className="w-4 h-4" />
                    Reschedule
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSkipId(r.id);
                      setSkipReason("");
                      setReschedId(null);
                    }}
                    disabled={actionLocked}
                    className="flex-1 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <CalendarOff className="w-4 h-4" />
                    Skip
                  </button>
                  {/* Deliberately the loud one: it emails the customer, so the
                      label says so and a confirm stands in front of it. */}
                  <button
                    type="button"
                    onClick={() => markDone(r)}
                    disabled={actionLocked}
                    className="flex-1 bg-green-600 text-white py-2.5 rounded-lg text-xs font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    It was done — notify customer
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bulk bar — reschedule + skip only. Done is never bulk: it emails. */}
      {selected.size > 0 && (
        <div className="bg-gray-900 rounded-lg p-3 space-y-2.5">
          <p className="text-xs font-semibold text-white">
            {selected.size} selected
          </p>
          <div className="flex gap-2">
            <input
              type="date"
              min={today}
              value={bulkDate}
              onChange={(e) => setBulkDate(e.target.value)}
              aria-label="New due date for selected visits"
              className="flex-1 border border-gray-600 bg-gray-800 text-white rounded-lg px-2.5 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => bulk("reschedule")}
              disabled={bulkBusy || !bulkDate}
              className="px-3 bg-white text-gray-900 py-2 rounded-lg text-xs font-semibold active:bg-gray-200 disabled:opacity-50 flex-shrink-0"
            >
              Reschedule selected
            </button>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              maxLength={500}
              placeholder="Skip reason (required)"
              className="flex-1 border border-gray-600 bg-gray-800 text-white placeholder-gray-500 rounded-lg px-2.5 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => bulk("skip")}
              disabled={bulkBusy || !bulkReason.trim()}
              className="px-3 bg-white text-gray-900 py-2 rounded-lg text-xs font-semibold active:bg-gray-200 disabled:opacity-50 flex-shrink-0"
            >
              Skip selected
            </button>
          </div>
          <p className="text-[11px] text-gray-400">
            Skipping tells each selected customer why. Rescheduling moves the
            visit quietly. Neither is offered for done — that one emails.
          </p>
        </div>
      )}
    </section>
  );
}