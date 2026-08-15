"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { useToast } from "@/components/Toast";
import { generateDueDates, summarizeSchedule } from "@/lib/lawnRecurrence";
import { Loader2, RefreshCw, Pause, Play, Calendar } from "lucide-react";

type Schedule = {
  id: string;
  job_id: string;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  service_type: string | null;
  price_per_visit: number;
  active: boolean;
  notes: string | null;
  // customers is reached through jobs (recurring_schedules has job_id, no
  // customer_id) — embed jobs(name, customers(name)).
  jobs: { name: string; customers: { name: string | null } | null } | null;
};

type Visit = {
  id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  notes: string | null;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

export default function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();

  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState("");

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
      const role = profile?.role ?? "crew";
      if (role !== "office" && role !== "admin" && role !== "super_admin") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      const { data: sched } = await supabase
        .from("recurring_schedules")
        .select(
          "id, job_id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, service_type, price_per_visit, active, notes, jobs(name, customers(name))"
        )
        .eq("id", id)
        .maybeSingle();
      if (!sched) {
        toast.error("Schedule not found");
        router.push("/lawn");
        return;
      }
      setSchedule(sched as unknown as Schedule);

      const { data: visitRows } = await supabase
        .from("lawn_visits")
        .select("id, due_date, status, crew_id, notes")
        .eq("recurring_schedule_id", id)
        .order("due_date", { ascending: true });
      setVisits((visitRows as unknown as Visit[]) ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function toggleActive() {
    if (!schedule) return;
    setBusy(true);
    const supabase = createClient();
    const next = !schedule.active;
    const { error } = await supabase
      .from("recurring_schedules")
      .update({ active: next })
      .eq("id", schedule.id);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setSchedule({ ...schedule, active: next });
    toast.success(next ? "Route resumed" : "Route paused");
  }

  // Regenerate / extend: fill visits from the day after the last existing visit
  // (or season start / today) through min(end_date, today+60d). Existing dates
  // are skipped via the unique (schedule, due_date) index (23505 ignored).
  async function regenerate() {
    if (!schedule) return;
    setRegenerating(true);
    const supabase = createClient();
    const today = new Date().toISOString().slice(0, 10);
    const lastDue = visits.length > 0 ? visits[visits.length - 1].due_date : "";
    // Start after the latest known visit date, but never before today.
    let from = today;
    if (lastDue && lastDue >= today) from = lastDue;
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + 60);
    let genTo = to.toISOString().slice(0, 10);
    if (schedule.end_date && schedule.end_date < genTo) genTo = schedule.end_date;

    const dueDates = generateDueDates(
      {
        frequency: schedule.frequency,
        interval_weeks: schedule.interval_weeks,
        days_of_week: schedule.days_of_week,
        day_of_month: schedule.day_of_month,
        start_date: schedule.start_date,
        end_date: schedule.end_date,
      },
      from,
      genTo
    );
    if (dueDates.length === 0) {
      toast.warning("No new visit dates in range (season may have ended)");
      setRegenerating(false);
      return;
    }
    const inserts = dueDates.map((due_date) => ({
      recurring_schedule_id: schedule.id,
      job_id: schedule.job_id,
      due_date,
      status: "pending" as const,
    }));
    const { error } = await supabase.from("lawn_visits").insert(inserts);
    setRegenerating(false);
    if (error && error.code !== "23505") {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    // Refresh the visit list.
    const { data: visitRows } = await supabase
      .from("lawn_visits")
      .select("id, due_date, status, crew_id, notes")
      .eq("recurring_schedule_id", schedule.id)
      .order("due_date", { ascending: true });
    setVisits((visitRows as unknown as Visit[]) ?? []);
    toast.success(`Generated ${dueDates.length} upcoming visit date${dueDates.length === 1 ? "" : "s"}`);
  }

  async function skipVisit(visitId: string) {
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("lawn_visits")
      .update({ status: "skipped" })
      .eq("id", visitId);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setVisits((prev) =>
      prev.map((v) => (v.id === visitId ? { ...v, status: "skipped" } : v))
    );
    toast.success("Visit skipped");
  }

  async function confirmMove(visitId: string) {
    if (!moveDate) {
      toast.warning("Pick a new date");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("lawn_visits")
      .update({ due_date: moveDate })
      .eq("id", visitId);
    setBusy(false);
    if (error) {
      // 23505 = a visit already exists on that date for this schedule.
      if (error.code === "23505") {
        toast.error("A visit already exists on that date for this schedule");
      } else {
        toast.error(`Failed: ${error.message}`);
      }
      return;
    }
    setVisits((prev) =>
      prev
        .map((v) => (v.id === visitId ? { ...v, due_date: moveDate } : v))
        .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
    );
    setMovingId(null);
    setMoveDate("");
    toast.success("Visit moved");
  }

  if (!authorized || !schedule) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  const jobName = schedule.jobs?.name ?? "—";
  const custName = schedule.jobs?.customers?.name ?? null;
  const schedSummary = summarizeSchedule({
    frequency: schedule.frequency,
    days_of_week: schedule.days_of_week,
    day_of_month: schedule.day_of_month,
    price_per_visit: Number(schedule.price_per_visit) || 0,
  });

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title={jobName} backHref="/lawn" backLabel="Lawn" />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-2">
          <div className="flex justify-between items-start">
            <div className="min-w-0">
              <p className="text-xs text-gray-500">{custName ?? "—"}</p>
              <p className="font-semibold text-gray-900">{schedule.service_type ?? "Service"}</p>
            </div>
            <span
              className={`text-[10px] font-semibold px-2 py-1 rounded ${
                schedule.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {schedule.active ? "Active" : "Paused"}
            </span>
          </div>
          <p className="text-sm text-gray-700">{schedSummary}</p>
          <p className="text-xs text-gray-500">
            Season: {schedule.start_date}
            {schedule.end_date ? ` → ${schedule.end_date}` : " → open"}
          </p>
          {schedule.notes && (
            <p className="text-xs text-gray-500 pt-1 border-t border-gray-100">
              {schedule.notes}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={toggleActive}
              disabled={busy}
              className="flex-1 bg-white border border-gray-300 text-gray-900 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {schedule.active ? (
                <>
                  <Pause className="w-4 h-4" />
                  Pause route
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Resume
                </>
              )}
            </button>
            <button
              type="button"
              onClick={regenerate}
              disabled={regenerating}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {regenerating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Generate / extend
            </button>
          </div>
        </div>

        <div>
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
            Visits ({visits.length})
          </h2>
          {visits.length === 0 ? (
            <div className="bg-white rounded-lg p-4 text-center">
              <p className="text-sm text-gray-500">
                No visits yet. Tap &ldquo;Generate / extend&rdquo; to seed upcoming dates.
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {visits.map((v) => (
                <div key={v.id} className="p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <Link
                      href={`/lawn/visits/${v.id}`}
                      className="text-sm font-medium text-gray-900 flex items-center gap-1.5"
                    >
                      <Calendar className="w-3.5 h-3.5 text-gray-400" />
                      {v.due_date}
                    </Link>
                    <span
                      className={`text-[10px] font-semibold px-2 py-1 rounded ${
                        STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {v.status}
                    </span>
                  </div>
                  {v.status === "pending" && (
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/lawn/visits/${v.id}`}
                        className="text-xs text-blue-600 font-medium"
                      >
                        Open
                      </Link>
                      {movingId === v.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            value={moveDate}
                            onChange={(e) => setMoveDate(e.target.value)}
                            className="px-2 py-1 border border-gray-300 rounded text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => confirmMove(v.id)}
                            disabled={busy}
                            className="text-xs text-blue-600 font-medium"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setMovingId(null);
                              setMoveDate("");
                            }}
                            className="text-xs text-gray-500"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setMovingId(v.id);
                              setMoveDate(v.due_date);
                            }}
                            disabled={busy}
                            className="text-xs text-gray-600 font-medium"
                          >
                            Move
                          </button>
                          <button
                            type="button"
                            onClick={() => skipVisit(v.id)}
                            disabled={busy}
                            className="text-xs text-gray-600 font-medium"
                          >
                            Skip
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}