import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import { OFFICE_LIKE } from "@/lib/roles";
import { summarizeSchedule } from "@/lib/lawnRecurrence";
import Link from "next/link";
import { Plus, Sprout, CalendarDays, Calendar, Route, Scissors, CloudSun, FileText } from "lucide-react";

// Row shapes for the relation joins (Supabase types these loosely, so we cast
// via `as unknown as Row[]` — same pattern as estimates/page.tsx).
type VisitRow = {
  id: string;
  due_date: string;
  status: string;
  // customers is reached THROUGH jobs (lawn_visits has job_id, no customer_id),
  // so the embed is jobs(..., customers(name)) — a direct customers(name) here
  // would 400 (PGRST118, no FK) and null out the whole query.
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
  } | null;
};
type ScheduleRow = {
  id: string;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  service_type: string | null;
  price_per_visit: number;
  active: boolean;
  jobs: { name: string; customers: { name: string | null } | null } | null;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

function dueLabel(dueDate: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return "Overdue";
  if (dueDate === today) return "Today";
  return new Date(`${dueDate}T00:00:00.000Z`).toLocaleDateString();
}

export default async function LawnPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  // The Lawn tab is for dispatchers/managers (office / admin / super_admin).
  // Crew field completion is Phase 2.
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const today = new Date().toISOString().slice(0, 10);

  // Today's Route: pending visits due today or overdue, newest job context.
  // RLS scopes both reads to this user's org (no manual org filter).
  const [{ data: visits }, { data: schedules }] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select("id, due_date, status, jobs(name, address, customers(name))")
      .eq("status", "pending")
      .lte("due_date", today)
      .order("due_date", { ascending: true }),
    supabase
      .from("recurring_schedules")
      .select(
        "id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, service_type, price_per_visit, active, jobs(name, customers(name))"
      )
      .order("active", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);

  const visitRows = (visits as unknown as VisitRow[] | null) ?? [];
  const scheduleRows = (schedules as unknown as ScheduleRow[] | null) ?? [];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Lawn" subtitle="Recurring routes & today's visits" />

      <main className="max-w-md mx-auto p-4 space-y-6">
        <div className="grid grid-cols-2 gap-2">
          <Link
            href="/lawn/new"
            className="block bg-green-600 text-white text-center py-3 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" />
            New lawn job
          </Link>
          <Link
            href="/lawn/calendar"
            className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <Calendar className="w-5 h-5" />
            Calendar
          </Link>
          <Link
            href="/lawn/routes"
            className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <Route className="w-5 h-5" />
            Routes
          </Link>
          <Link
            href="/lawn/services"
            className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <Scissors className="w-5 h-5" />
            Services
          </Link>
          <Link
            href="/lawn/weather"
            className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <CloudSun className="w-5 h-5" />
            Weather
          </Link>
          <Link
            href="/lawn/billing"
            className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <FileText className="w-5 h-5" />
            Billing
          </Link>
        </div>

        {/* ── Today's Route ─────────────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <CalendarDays className="w-3.5 h-3.5" />
            Today&rsquo;s Route
          </h2>
          {visitRows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={CalendarDays}
                title="Nothing due today"
                description="Pending lawn visits due today or overdue will show up here."
              />
            </div>
          ) : (
            <div className="space-y-2">
              {visitRows.map((v) => {
                const jobName = v.jobs?.name ?? "—";
                const custName = v.jobs?.customers?.name ?? null;
                return (
                  <Link
                    key={v.id}
                    href={`/lawn/visits/${v.id}`}
                    className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 truncate">
                          {jobName}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {custName ? `${custName} · ` : ""}
                          {v.jobs?.address ?? "—"}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-semibold px-2 py-1 rounded ${
                          STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600"
                        } whitespace-nowrap`}
                      >
                        {dueLabel(v.due_date)}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Recurring Schedules ───────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <Sprout className="w-3.5 h-3.5" />
            Recurring Schedules
          </h2>
          {scheduleRows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={Sprout}
                title="No recurring schedules yet"
                description="Create a lawn job to set up a recurring route."
                action={
                  <Link
                    href="/lawn/new"
                    className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold"
                  >
                    <Plus className="w-4 h-4" />
                    New lawn job
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="space-y-2">
              {scheduleRows.map((s) => {
                const jobName = s.jobs?.name ?? "—";
                const custName = s.jobs?.customers?.name ?? null;
                const sched = {
                  frequency: s.frequency,
                  days_of_week: s.days_of_week,
                  day_of_month: s.day_of_month,
                  price_per_visit: Number(s.price_per_visit) || 0,
                };
                return (
                  <Link
                    key={s.id}
                    href={`/lawn/schedules/${s.id}`}
                    className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-gray-900 truncate">
                          {jobName}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {custName ? `${custName} · ` : ""}
                          {s.service_type ?? "Service"}
                          {!s.active && " · paused"}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {summarizeSchedule(sched)}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${
                          s.active
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {s.active ? "Active" : "Paused"}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}