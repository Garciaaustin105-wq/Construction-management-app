import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import PageContainer from "@/components/PageContainer";
import EmptyState from "@/components/EmptyState";
import { OFFICE_LIKE } from "@/lib/roles";
import { CalendarDays, ChevronLeft, ChevronRight, Check } from "lucide-react";

// Monthly lawn route calendar (dispatcher view). A month grid where each day's
// visit chips are color-coded by the assigned crew + the route (service) name,
// with a crew legend below that maps each crew to the jobs they're on this
// month. Crew is resolved from a separate profiles query (lawn_visits.crew_id
// is not an FK embed — same approach as the visit page). RLS scopes both reads
// to this org.

const CREW_COLORS = [
  { dot: "bg-blue-500", chip: "bg-blue-50 text-blue-800 border border-blue-200" },
  { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-800 border border-emerald-200" },
  { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 border border-amber-200" },
  { dot: "bg-purple-500", chip: "bg-purple-50 text-purple-800 border border-purple-200" },
  { dot: "bg-pink-500", chip: "bg-pink-50 text-pink-800 border border-pink-200" },
  { dot: "bg-cyan-500", chip: "bg-cyan-50 text-cyan-800 border border-cyan-200" },
  { dot: "bg-orange-500", chip: "bg-orange-50 text-orange-800 border border-orange-200" },
  { dot: "bg-indigo-500", chip: "bg-indigo-50 text-indigo-800 border border-indigo-200" },
];
const UNASSIGNED_COLOR = {
  dot: "bg-gray-400",
  chip: "bg-gray-50 text-gray-600 border border-gray-200",
};
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MAX_CHIPS_PER_CELL = 3;
const MAX_CHIPS_PER_CELL_DESKTOP = 6;

type CalVisit = {
  id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  recurring_schedules: { service_type: string | null } | null;
  jobs: { name: string | null } | null;
};

function parseMonth(s: string | undefined): { year: number; month: number; iso: string } {
  const now = new Date();
  if (s && /^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split("-").map(Number);
    return { year: y, month: m - 1, iso: s };
  }
  const y = now.getFullYear();
  const m = now.getMonth();
  return { year: y, month: m, iso: `${y}-${String(m + 1).padStart(2, "0")}` };
}

function shiftMonth(year: number, month: number, delta: number): string {
  const d = new Date(year, month + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.trim().slice(0, 3).toUpperCase();
}

export default async function LawnCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const { year, month, iso } = parseMonth(sp.month);
  const monthStart = `${iso}-01`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthEnd = `${iso}-${String(daysInMonth).padStart(2, "0")}`;
  const todayIso = new Date().toISOString().slice(0, 10);
  const isCurrentMonth = iso === todayIso.slice(0, 7);

  const [{ data: visitRows }, { data: crewRows }] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select(
        "id, due_date, status, crew_id, recurring_schedules(service_type), jobs(name)"
      )
      .gte("due_date", monthStart)
      .lte("due_date", monthEnd)
      .order("due_date", { ascending: true }),
    supabase
      .from("crew_members")
      .select("id, name")
      .order("name"),
  ]);

  const visits = (visitRows as unknown as CalVisit[] | null) ?? [];
  const crew = (crewRows as { id: string; name: string }[] | null) ?? [];

  // Stable crew color assignment (sorted crew order). crew_id referencing a
  // crew_members row outside this query falls back to the Unassigned bucket.
  const crewById = new Map<string, { name: string; colorIdx: number }>();
  crew.forEach((c, i) => {
    crewById.set(c.id, {
      name: c.name?.trim() || "Crew",
      colorIdx: i % CREW_COLORS.length,
    });
  });
  const UNASSIGNED_KEY = "__unassigned__";
  function crewOf(v: CalVisit): { key: string; name: string; colorIdx: number | null } {
    if (v.crew_id && crewById.has(v.crew_id)) {
      const c = crewById.get(v.crew_id)!;
      return { key: v.crew_id, name: c.name, colorIdx: c.colorIdx };
    }
    return { key: UNASSIGNED_KEY, name: "Unassigned", colorIdx: null };
  }
  function colorFor(colorIdx: number | null) {
    return colorIdx === null ? UNASSIGNED_COLOR : CREW_COLORS[colorIdx % CREW_COLORS.length];
  }

  // Group visits by due_date + build the legend (per-crew jobs this month).
  const visitsByDate = new Map<string, CalVisit[]>();
  type LegendEntry = { key: string; name: string; colorIdx: number | null; jobNames: string[]; visitCount: number };
  const legend = new Map<string, LegendEntry>();
  for (const v of visits) {
    const arr = visitsByDate.get(v.due_date) ?? [];
    arr.push(v);
    visitsByDate.set(v.due_date, arr);

    const c = crewOf(v);
    let entry = legend.get(c.key);
    if (!entry) {
      entry = { key: c.key, name: c.name, colorIdx: c.colorIdx, jobNames: [], visitCount: 0 };
      legend.set(c.key, entry);
    }
    entry.visitCount += 1;
    const jobName = v.jobs?.name ?? null;
    if (jobName && !entry.jobNames.includes(jobName)) entry.jobNames.push(jobName);
  }
  const legendList = Array.from(legend.values()).sort((a, b) => {
    // Unassigned last; otherwise by name.
    if (a.key === UNASSIGNED_KEY) return 1;
    if (b.key === UNASSIGNED_KEY) return -1;
    return a.name.localeCompare(b.name);
  });

  // Build the month grid (Mon-start). Leading blanks fill the first week.
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const leading = (firstWeekday + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <PageContainer title="Lawn Calendar" subtitle="Monthly crew routes" backHref="/lawn" backLabel="Lawn" maxWidth="full">
      {/* Month nav */}
      <div className="flex items-center justify-between">
        <Link
          href={`/lawn/calendar?month=${shiftMonth(year, month, -1)}`}
          className="p-2 -ml-2 text-gray-600 active:text-gray-900"
          aria-label="Previous month"
        >
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div className="text-center">
          <p className="text-base font-bold text-gray-900">
            {MONTH_NAMES[month]} {year}
          </p>
          {!isCurrentMonth && (
            <Link
              href="/lawn/calendar"
              className="text-xs text-blue-600 font-medium"
            >
              Today
            </Link>
          )}
        </div>
        <Link
          href={`/lawn/calendar?month=${shiftMonth(year, month, 1)}`}
          className="p-2 -mr-2 text-gray-600 active:text-gray-900"
          aria-label="Next month"
        >
          <ChevronRight className="w-5 h-5" />
        </Link>
      </div>

      {/* Day-name row */}
      <div className="grid grid-cols-7 gap-1">
        {DAY_LABELS.map((d) => (
          <div key={d} className="text-center text-[10px] font-semibold text-gray-400 uppercase">
            {d}
          </div>
        ))}
      </div>

      {/* Month grid */}
      {visits.length === 0 ? (
        <div className="bg-white rounded-lg">
          <EmptyState
            icon={CalendarDays}
            title="No visits this month"
            description="Lawn visits scheduled this month will appear here, color-coded by crew."
          />
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (d === null) return <div key={`b-${i}`} className="min-h-[64px] lg:min-h-[110px]" />;
            const dateStr = `${iso}-${String(d).padStart(2, "0")}`;
            const dayVisits = visitsByDate.get(dateStr) ?? [];
            const isToday = dateStr === todayIso;
            // Desktop cells are taller, so they can show more chips before
            // falling back to "+N more" — render up to the desktop cap, but
            // hide the extra (mobile..desktop] chips with lg: so mobile still
            // only sees MAX_CHIPS_PER_CELL.
            const shown = dayVisits.slice(0, MAX_CHIPS_PER_CELL_DESKTOP);
            const mobileExtra = dayVisits.length - Math.min(dayVisits.length, MAX_CHIPS_PER_CELL);
            const desktopExtra = dayVisits.length - shown.length;
            return (
              <div
                key={dateStr}
                className={`min-h-[64px] lg:min-h-[110px] rounded-lg p-1 lg:p-1.5 flex flex-col gap-1 ${
                  isToday ? "bg-blue-50 ring-1 ring-blue-300" : "bg-white"
                }`}
              >
                <span
                  className={`text-[10px] lg:text-xs font-semibold ${
                    isToday ? "text-blue-700" : "text-gray-400"
                  } self-end leading-none`}
                >
                  {d}
                </span>
                {shown.map((v, idx) => {
                  const c = crewOf(v);
                  const col = colorFor(c.colorIdx);
                  return (
                    <Link
                      key={v.id}
                      href={`/lawn/visits/${v.id}`}
                      className={`block rounded px-1 py-0.5 text-[10px] leading-tight truncate ${col.chip} ${
                        v.status === "skipped" ? "line-through opacity-60" : ""
                      } ${idx >= MAX_CHIPS_PER_CELL ? "hidden lg:block" : ""}`}
                    >
                      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${col.dot}`} />
                      <span className="font-semibold align-middle">{initials(c.name)}</span>
                      <span className="align-middle">
                        {" "}
                        {v.recurring_schedules?.service_type ?? "Service"}
                      </span>
                      {v.status === "done" && (
                        <Check className="inline w-2.5 h-2.5 ml-0.5 align-middle" />
                      )}
                    </Link>
                  );
                })}
                {mobileExtra > 0 && (
                  <span className="text-[9px] text-gray-400 px-1 lg:hidden">+{mobileExtra} more</span>
                )}
                {desktopExtra > 0 && (
                  <span className="hidden lg:block text-[9px] text-gray-400 px-1">+{desktopExtra} more</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Crew legend — each crew mapped to the jobs they're on this month */}
      {legendList.length > 0 && (
        <section className="space-y-2 pt-2">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">
            Crew &amp; Jobs
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {legendList.map((e) => {
              const col = colorFor(e.colorIdx);
              return (
                <div key={e.key} className="bg-white rounded-lg p-3 shadow-sm">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-3 h-3 rounded-full ${col.dot}`} />
                    <span className="font-semibold text-gray-900 text-sm truncate">
                      {e.name}
                    </span>
                    <span className="text-xs text-gray-400 ml-auto whitespace-nowrap">
                      {e.visitCount} visit{e.visitCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {e.jobNames.length > 0 && (
                    <p className="text-xs text-gray-500 mt-1 leading-snug">
                      {e.jobNames.join(" · ")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </PageContainer>
  );
}