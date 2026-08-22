"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { useToast } from "@/components/Toast";
import { generateDueDates, summarizeSchedule } from "@/lib/lawnRecurrence";
import { Loader2, RefreshCw, Pause, Play, Calendar } from "lucide-react";
import LawnPropertyDetails, {
  type LawnJob,
} from "@/components/LawnPropertyDetails";
import JobDetailsEditor from "@/components/JobDetailsEditor";
import JobAssignmentEditor from "@/components/JobAssignmentEditor";
import RecurringScheduleEditor from "@/components/RecurringScheduleEditor";
import LawnJobFinancials from "@/components/LawnJobFinancials";
import dynamic from "next/dynamic";

// Only mounts after "Skip" is pressed on a visit row — kept out of the
// first-load bundle.
const SkipReasonPicker = dynamic(
  () => import("@/components/SkipReasonPicker"),
  {
    ssr: false,
    loading: () => (
      <div className="h-[104px] rounded-lg bg-amber-50 border border-amber-200 animate-pulse" />
    ),
  }
);

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
  paused_from: string | null;
  paused_until: string | null;
  notes: string | null;
  // customers is reached through jobs (recurring_schedules has job_id, no
  // customer_id) — embed jobs(name, address, description, customers(name)).
  // address/description live on the jobs row (same as construction) so the
  // JobDetailsEditor can edit them by job id.
  jobs: {
    name: string;
    address: string | null;
    description: string | null;
    customer_id: string | null;
    assigned_crew: string[] | null;
    customers: { name: string | null } | null;
  } | null;
};

type Visit = {
  id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  notes: string | null;
  skip_reason: string | null;
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
  const [property, setProperty] = useState<LawnJob | null>(null);
  const [lawnServices, setLawnServices] = useState<
    { id: string; name: string; default_price: number }[]
  >([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState("");
  const [skippingId, setSkippingId] = useState<string | null>(null);

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
          "id, job_id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, service_type, price_per_visit, active, paused_from, paused_until, notes, jobs(name, address, description, customer_id, assigned_crew, customers(name))"
        )
        .eq("id", id)
        .maybeSingle();
      if (!sched) {
        toast.error("Schedule not found");
        router.push("/lawn");
        return;
      }
      setSchedule(sched as unknown as Schedule);

      const jobId = (sched as unknown as Schedule).job_id;
      const [{ data: visitRows }, { data: lawnJob }, { data: services }] = await Promise.all([
        supabase
          .from("lawn_visits")
          .select("id, due_date, status, crew_id, notes, skip_reason")
          .eq("recurring_schedule_id", id)
          .order("due_date", { ascending: true }),
        supabase
          .from("lawn_jobs")
          .select("*")
          .eq("id", jobId)
          .maybeSingle(),
        supabase
          .from("lawn_services")
          .select("id, name, default_price")
          .eq("active", true)
          .order("name"),
      ]);
      setVisits((visitRows as unknown as Visit[]) ?? []);
      setProperty((lawnJob as unknown as LawnJob | null) ?? null);
      setLawnServices(
        (services as { id: string; name: string; default_price: number }[]) ??
          []
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // JobDetailsEditor save callback: this page is a client component whose data
  // is fetched in a useEffect (deps [id]), so router.refresh() won't re-fetch.
  // Update the schedule state directly so the location card + TopBar title
  // reflect the edited name/address/description immediately.
  function onJobDetailsSaved(
    name: string,
    address: string | null,
    description: string | null
  ) {
    setSchedule((prev) =>
      prev
        ? {
            ...prev,
            jobs: prev.jobs
              ? { ...prev.jobs, name, address, description }
              : { name, address, description, customer_id: null, assigned_crew: null, customers: null },
          }
        : prev
    );
  }

  // JobAssignmentEditor save callback: update schedule state so the customer +
  // crew reflect the change without a refetch (same reason as onJobDetailsSaved).
  function onAssignmentSaved(customerId: string | null, crew: string[]) {
    setSchedule((prev) =>
      prev
        ? {
            ...prev,
            jobs: prev.jobs
              ? { ...prev.jobs, customer_id: customerId, assigned_crew: crew }
              : prev.jobs,
          }
        : prev
    );
  }

  // RecurringScheduleEditor save callback: update schedule state with the
  // edited recurrence patch so the top summary + resetUpcoming use the new
  // params without a refetch.
  function onScheduleSaved(patch: {
    frequency: string;
    interval_weeks: number;
    days_of_week: number[];
    day_of_month: number | null;
    start_date: string;
    end_date: string | null;
    service_type: string | null;
    price_per_visit: number;
    notes: string | null;
  }) {
    setSchedule((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function toggleActive() {
    if (!schedule) return;
    setBusy(true);
    const supabase = createClient();
    const next = !schedule.active;
    // Manual per-schedule pause/resume. On resume, clear any persisted
    // off-season window so a pending auto-resume can't override the manual
    // action. On pause, leave the window null — a manual hold has no
    // auto-resume (only bulk-pause sets a window).
    const patch: Record<string, unknown> = { active: next };
    if (next) {
      patch.paused_from = null;
      patch.paused_until = null;
    }
    const { error } = await supabase
      .from("recurring_schedules")
      .update(patch)
      .eq("id", schedule.id);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setSchedule({
      ...schedule,
      active: next,
      ...(next ? { paused_from: null, paused_until: null } : {}),
    });
    toast.success(next ? "Route resumed" : "Route paused");
  }

  // Regenerate / extend: fill visits from the day after the last existing visit
  // (or season start / today) through min(end_date, today+60d). Existing dates
  // are skipped via the unique (schedule, due_date) index (23505 ignored).
  async function regenerate() {
    if (!schedule) return;
    // Don't generate visits for a paused route — the seasonal pause relies on
    // active=false stopping the nightly cron, and bulk-resume is the intended
    // way back. Generating here would seed visits the pause meant to suppress.
    if (!schedule.active) {
      toast.warning("Resume the route first");
      return;
    }
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
      .select("id, due_date, status, crew_id, notes, skip_reason")
      .eq("recurring_schedule_id", schedule.id)
      .order("due_date", { ascending: true });
    setVisits((visitRows as unknown as Visit[]) ?? []);
    toast.success(`Generated ${dueDates.length} upcoming visit date${dueDates.length === 1 ? "" : "s"}`);
  }

  // Apply the (just-saved) schedule to upcoming visits: delete future PENDING
  // visits (done/skipped/paused are history, preserved) then regenerate from
  // today through min(end_date, today+60d). Used after editing mow days so the
  // new cadence actually reshapes what's upcoming. RLS: "Office manage lawn
  // visits" (for all, tier_office_or_pm) permits the delete.
  async function resetUpcoming() {
    if (!schedule) return;
    if (!schedule.active) {
      toast.warning("Resume the route first");
      return;
    }
    setResetting(true);
    const supabase = createClient();
    const today = new Date().toISOString().slice(0, 10);
    // Delete only future pending visits — preserve completed/skipped history.
    const { error: delErr } = await supabase
      .from("lawn_visits")
      .delete()
      .eq("recurring_schedule_id", schedule.id)
      .eq("status", "pending")
      .gte("due_date", today);
    if (delErr) {
      setResetting(false);
      toast.error(`Failed to clear visits: ${delErr.message}`);
      return;
    }
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
      today,
      genTo
    );
    if (dueDates.length > 0) {
      const inserts = dueDates.map((due_date) => ({
        recurring_schedule_id: schedule.id,
        job_id: schedule.job_id,
        due_date,
        status: "pending" as const,
      }));
      const { error: insErr } = await supabase.from("lawn_visits").insert(inserts);
      if (insErr && insErr.code !== "23505") {
        setResetting(false);
        toast.error(`Failed to generate: ${insErr.message}`);
        return;
      }
    }
    const { data: visitRows } = await supabase
      .from("lawn_visits")
      .select("id, due_date, status, crew_id, notes, skip_reason")
      .eq("recurring_schedule_id", schedule.id)
      .order("due_date", { ascending: true });
    setVisits((visitRows as unknown as Visit[]) ?? []);
    setResetting(false);
    toast.success(
      `Upcoming visits reset · ${dueDates.length} date${
        dueDates.length === 1 ? "" : "s"
      }`
    );
  }

  async function skipVisit(visitId: string, skipReason: string) {
    setBusy(true);
    // Route through the /status API (not a direct update) so the customer is
    // emailed (with the reason) + notified_skipped_at stamped — same path as
    // the visit detail page.
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visitId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "skipped", skip_reason: skipReason }),
      });
    } catch {
      setBusy(false);
      toast.error("Failed: network error");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    setVisits((prev) =>
      prev.map((v) =>
        v.id === visitId
          ? { ...v, status: "skipped", skip_reason: skipReason.trim() || null }
          : v
      )
    );
    setSkippingId(null);
    toast.success("Visit skipped");
  }

  async function confirmMove(visitId: string) {
    if (!moveDate) {
      toast.warning("Pick a new date");
      return;
    }
    setBusy(true);
    // Route through the /status API so a move emails the customer + stamps
    // notified_at (a direct update would silently skip both).
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visitId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_date: moveDate }),
      });
    } catch {
      setBusy(false);
      toast.error("Failed: network error");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      // 23505 = a visit already exists on that date for this schedule.
      if (data.code === "23505") {
        toast.error("A visit already exists on that date for this schedule");
      } else {
        toast.error(`Failed: ${data.error ?? res.statusText}`);
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
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title={jobName} backHref="/lawn" backLabel="Lawn" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
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
              {schedule.active
                ? "Active"
                : schedule.paused_until
                  ? `Paused → ${schedule.paused_until}`
                  : "Paused"}
            </span>
          </div>
          <p className="text-sm text-gray-700">{schedSummary}</p>
          <p className="text-xs text-gray-500">
            Season: {schedule.start_date}
            {schedule.end_date ? ` → ${schedule.end_date}` : " → open"}
          </p>
          {!schedule.active && schedule.paused_until && (
            <p className="text-xs text-blue-600 font-medium">
              Auto-resumes {schedule.paused_until}
            </p>
          )}
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

          {/* Export this property's full record (photos, visits, invoices) as a
              ZIP — the "keep your data" companion so removing an old account
              (e.g. to fit a lower plan after a season ends) isn't data loss.
              Server route /api/jobs/[id]/export is office-gated + reads this
              job_id's photos/visits/estimates/invoices. */}
          <a
            href={`/api/jobs/${schedule.job_id}/export`}
            className="block w-full text-center bg-gray-100 text-gray-700 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-200"
          >
            Export this property (ZIP)
          </a>
          <p className="text-xs text-gray-400 text-center">
            Download all photos, visits &amp; records before removing an old account.
          </p>
        </div>

        {/* Recurring schedule — mow days, frequency, season, service, price.
            Editable after creation (was read-only for life). Saving updates the
            row; tap "Reset upcoming" below to apply the new cadence to future
            visits (deletes future pending, preserves done/skipped history). */}
        <RecurringScheduleEditor
          scheduleId={schedule.id}
          initial={{
            frequency: schedule.frequency as "weekly" | "biweekly" | "monthly",
            interval_weeks: schedule.interval_weeks,
            days_of_week: schedule.days_of_week,
            day_of_month: schedule.day_of_month,
            start_date: schedule.start_date,
            end_date: schedule.end_date,
            service_type: schedule.service_type,
            price_per_visit: Number(schedule.price_per_visit) || 0,
            notes: schedule.notes,
          }}
          lawnServices={lawnServices}
          canEdit={authorized}
          onSaved={onScheduleSaved}
        />
        <button
          type="button"
          onClick={resetUpcoming}
          disabled={resetting || !schedule.active}
          className="w-full bg-white border border-gray-300 text-gray-900 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {resetting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Reset upcoming visits
        </button>
        <p className="text-xs text-gray-400 -mt-2">
          Clears future pending visits and regenerates them from the saved
 schedule. Past visits are kept.
        </p>

        {/* Property location / name / notes — editable after creation (same
            JobDetailsEditor as the construction job page; edits the jobs row by
            id, since a lawn job's address/description live on jobs). */}
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Location</h2>
          <JobDetailsEditor
            jobId={schedule.job_id}
            initialName={schedule.jobs?.name ?? ""}
            initialAddress={schedule.jobs?.address ?? null}
            initialDescription={schedule.jobs?.description ?? null}
            canEdit={authorized}
            onSaved={onJobDetailsSaved}
          />
        </section>

        {/* Customer + crew assignment — editable after creation. JobDetailsEditor
            only covers name/address/description; this handles jobs.customer_id +
            jobs.assigned_crew (reassign customer / change crew). */}
        <JobAssignmentEditor
          jobId={schedule.job_id}
          initialCustomerId={schedule.jobs?.customer_id ?? null}
          initialCrew={schedule.jobs?.assigned_crew ?? []}
          canEdit={authorized}
          onSaved={onAssignmentSaved}
        />

        {/* Property profile (lawn_jobs 1:1) */}
        <LawnPropertyDetails
          jobId={schedule.job_id}
          initial={property}
          canEdit={authorized}
        />

        {/* Estimates & invoices for this lawn job — create + manage from the
            Lawn tab via deep-links to the shared creators (?job=). */}
        <LawnJobFinancials jobId={schedule.job_id} canEdit={authorized} />

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
                  {v.status === "skipped" && v.skip_reason && (
                    <p className="text-xs text-gray-500">
                      Skipped · {v.skip_reason}
                    </p>
                  )}
                  {v.status === "pending" && skippingId === v.id ? (
                    <SkipReasonPicker
                      busy={busy}
                      onConfirm={(reason) => skipVisit(v.id, reason)}
                      onCancel={() => setSkippingId(null)}
                    />
                  ) : (
                    v.status === "pending" && (
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
                            onClick={() => setSkippingId(v.id)}
                            disabled={busy}
                            className="text-xs text-gray-600 font-medium"
                          >
                            Skip
                          </button>
                        </>
                      )}
                    </div>
                    )
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