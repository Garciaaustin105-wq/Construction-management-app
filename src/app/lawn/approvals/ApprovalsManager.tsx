"use client";

// The approval queue (gate 4). Lists lawn_visits where
// awaiting_approval_since is set — the database stamped them after gates 1-3
// passed; THIS PAGE does not judge whether a visit qualifies (the lib's
// assessSettlement is for DISPLAY of gate state elsewhere; the queue just
// needs to be listed and acted on).
//
// Approve MUST go through POST /api/lawn/visits/[id]/status — the route is
// what sends the service_complete email and review request; a direct
// lawn_visits.update({status:'done'}) silently skips both. "Not yet" only
// clears awaiting_approval_since back to null, leaving the visit pending so
// the cron re-queues it if it still qualifies.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import EmptyState from "@/components/EmptyState";
import { Check, Clock, Loader2, Users, Inbox, CheckCheck } from "lucide-react";

type QueueRow = {
  id: string;
  due_date: string;
  awaiting_approval_since: string;
  on_site_first_at: string | null;
  on_site_last_at: string | null;
  on_site_user_ids: string[] | null;
  jobs: { name: string; address: string | null; customers: { name: string | null } | null } | null;
};

function measuredMinutes(r: QueueRow): number | null {
  if (!r.on_site_first_at || !r.on_site_last_at) return null;
  return Math.max(0, Math.round((new Date(r.on_site_last_at).getTime() - new Date(r.on_site_first_at).getTime()) / 60000));
}

function sinceLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ApprovalsManager() {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  const [authorized, setAuthorized] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkApproving, setBulkApproving] = useState(false);

  const load = useCallback(async () => {
    // RLS scopes this to the org — no manual organization_id filter.
    const { data } = await supabase
      .from("lawn_visits")
      .select(
        "id, due_date, awaiting_approval_since, on_site_first_at, on_site_last_at, on_site_user_ids, jobs(name, address, customers(name))"
      )
      .not("awaiting_approval_since", "is", null)
      .order("awaiting_approval_since", { ascending: true });
    setRows((data as unknown as QueueRow[] | null) ?? []);
    setAuthorized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      const role = (profile?.role as string) ?? "crew";
      if (role !== "office" && role !== "admin") {
        router.push("/dashboard");
        return;
      }
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The one path that may complete a visit from here: the status route, which
  // is what notifies the customer. Never a direct table update.
  async function approve(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/lawn/visits/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? `Approve failed (${res.status})`);
        return;
      }
      const body = (await res.json().catch(() => null)) as { notified?: boolean } | null;
      toast.success(body?.notified ? "Approved — customer notified" : "Approved");
    } finally {
      setBusyId(null);
      await load();
    }
  }

  // Returns to the field without completing: the visit stays pending and the
  // cron re-queues it if it still qualifies.
  async function notYet(id: string) {
    setBusyId(id);
    const { error } = await supabase
      .from("lawn_visits")
      .update({ awaiting_approval_since: null })
      .eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    toast.success("Sent back — still pending");
    await load();
  }

  async function approveAll() {
    const n = rows.length;
    if (!confirm(`Approve all ${n} visit${n === 1 ? "" : "s"} listed above? Each approval emails that customer their completion notice.`)) return;
    setBulkApproving(true);
    setBulkBusy(true);
    try {
      let okCount = 0;
      for (const r of rows) {
        const res = await fetch(`/api/lawn/visits/${r.id}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });
        if (res.ok) okCount++;
      }
      if (okCount === n) {
        toast.success(`Approved all ${n}`);
      } else {
        toast.error(`Approved ${okCount} of ${n} — ${n - okCount} failed, still queued`);
      }
    } finally {
      setBulkApproving(false);
      setBulkBusy(false);
      await load();
    }
  }

  if (!authorized) {
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
        title="Nothing waiting for approval"
        description="When a crew finishes a visit and it passes your completion gates (crew gone, minimum time on site), it lands here for sign-off before the customer is emailed — if the completion mode is set to hold for approval."
      />
    );
  }

  return (
    <section className="space-y-4">
      <p className="text-xs text-gray-500">
        {rows.length} {rows.length === 1 ? "visit" : "visits"} finished and
        waiting. Approving tells the customer the job is done and requests a
        review; &ldquo;Not yet&rdquo; sends it back to the field without
        completing anything.
      </p>

      <div className="space-y-2">
        {rows.map((r) => {
          const minutes = measuredMinutes(r);
          const phones = r.on_site_user_ids?.length ?? 0;
          const busy = busyId === r.id;
          return (
            <div
              key={r.id}
              className="bg-white rounded-lg shadow-sm border border-gray-100 divide-y divide-gray-100"
            >
              <div className="p-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {r.jobs?.name ?? "—"}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {r.jobs?.customers?.name ? `${r.jobs.customers.name} · ` : ""}
                      {r.jobs?.address ?? "—"}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {new Date(`${r.due_date}T00:00:00.000Z`).toLocaleDateString()}
                      {" · "}
                      waiting since {sinceLabel(r.awaiting_approval_since)}
                    </p>
                  </div>
                </div>
                {/* Evidence the completion is real, not an assertion. */}
                <p className="text-xs text-gray-600 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-gray-400" />
                    {minutes === null
                      ? "No on-site window measured"
                      : `${minutes} min on site`}
                  </span>
                  {phones > 1 && (
                    <span className="inline-flex items-center gap-1">
                      <Users className="w-3.5 h-3.5 text-gray-400" />
                      {phones} phones on site
                    </span>
                  )}
                </p>
              </div>
              <div className="p-3 pt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => approve(r.id)}
                  disabled={busy || bulkApproving}
                  className="flex-1 bg-green-600 text-white py-2.5 rounded-lg text-sm font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => notYet(r.id)}
                  disabled={busy || bulkApproving}
                  className="flex-1 bg-white border border-gray-300 text-gray-700 py-2.5 rounded-lg text-sm font-semibold active:bg-gray-50 disabled:opacity-50"
                >
                  Not yet
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Approve all — only ever above the list it approves; every row is
          visible with its measured minutes before it can be pressed. */}
      <button
        type="button"
        onClick={approveAll}
        disabled={bulkApproving || bulkBusy || rows.length === 0}
        className="w-full bg-gray-900 text-white py-3 rounded-lg font-semibold text-sm active:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {bulkApproving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <CheckCheck className="w-4 h-4" />
        )}
        Approve all {rows.length}
      </button>
      <p className="text-[11px] text-gray-400 text-center -mt-1">
        Approves every visit listed above and emails each customer.
      </p>
    </section>
  );
}