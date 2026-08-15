import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import TimeExportButton, { type ExportRow } from "@/components/TimeExportButton";
import { Users, MapPin, ChevronLeft, ChevronRight, User, Briefcase } from "lucide-react";

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Monday of the week containing d (local time).
function startOfWeek(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0 = Sun … 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}
function addDays(d: Date, n: number): Date {
  const date = new Date(d);
  date.setDate(date.getDate() + n);
  return date;
}
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type Joined = {
  id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  note: string | null;
  lat: number | null;
  lng: number | null;
  user: { id: string; full_name: string | null } | null;
  job: { id: string; name: string | null } | null;
  cost_code: { code: string; name: string } | null;
};

function shiftDurationMs(s: Joined, now: number): number {
  const end = s.clock_out_at ? new Date(s.clock_out_at).getTime() : now;
  return Math.max(0, end - new Date(s.clock_in_at).getTime());
}

export default async function TimeOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ weekStart?: string }>;
}) {
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
  if ((profile?.role ?? "crew") !== "office") redirect("/dashboard");

  // ---- Week selection (default = current week, Monday-based) ----
  const sp = await searchParams;
  const today = new Date();
  let weekStart = startOfWeek(today);
  if (sp.weekStart) {
    const parsed = new Date(`${sp.weekStart}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) weekStart = startOfWeek(parsed);
  }
  const weekEnd = addDays(weekStart, 7);
  // Async server component — runs once per request, so Date.now() is the
  // request time (used to compute elapsed time for still-open shifts), not a
  // client-render side effect. react-hooks/purity is a false positive here.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const isCurrentWeek = toISODate(weekStart) === toISODate(startOfWeek(today));
  const prevWeek = toISODate(addDays(weekStart, -7));
  const nextWeek = toISODate(addDays(weekStart, 7));

  const weekLabel = `${weekStart.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })} – ${addDays(weekStart, 6).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })}`;

  // ---- Data: on-clock now, this week's shifts ----
  const [onClockRes, weekRes] = await Promise.all([
    supabase
      .from("time_entries")
      .select(
        "id, clock_in_at, lat, lng, user:profiles(full_name), job:jobs(name), cost_code:cost_codes(code, name)"
      )
      .is("clock_out_at", null)
      .order("clock_in_at", { ascending: false }),
    supabase
      .from("time_entries")
      .select(
        "id, clock_in_at, clock_out_at, note, lat, lng, user:profiles(id, full_name), job:jobs(id, name), cost_code:cost_codes(code, name)"
      )
      .gte("clock_in_at", weekStart.toISOString())
      .lt("clock_in_at", weekEnd.toISOString())
      .order("clock_in_at", { ascending: true }),
  ]);

  type OnClock = {
    id: string;
    clock_in_at: string;
    lat: number | null;
    lng: number | null;
    user: { full_name: string | null } | null;
    job: { name: string | null } | null;
    cost_code: { code: string; name: string } | null;
  };
  const onClockRows = (onClockRes.data ?? []) as unknown as OnClock[];
  const weekShifts = (weekRes.data ?? []) as unknown as Joined[];

  const weekTotalMs = weekShifts.reduce((sum, s) => sum + shiftDurationMs(s, now), 0);
  const weekHours = weekTotalMs / 3_600_000;

  // ---- Group by worker ----
  const byWorker = new Map<
    string,
    { name: string; shifts: Joined[]; ms: number }
  >();
  for (const s of weekShifts) {
    const id = s.user?.id ?? "unknown";
    const name = s.user?.full_name ?? "Unknown";
    const dur = shiftDurationMs(s, now);
    const entry = byWorker.get(id);
    if (entry) {
      entry.shifts.push(s);
      entry.ms += dur;
    } else {
      byWorker.set(id, { name, shifts: [s], ms: dur });
    }
  }
  const workers = Array.from(byWorker.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  // ---- Group by job (workers nested) ----
  const byJob = new Map<
    string,
    { name: string; ms: number; workers: Map<string, { name: string; shifts: Joined[]; ms: number }> }
  >();
  for (const s of weekShifts) {
    const id = s.job?.id ?? "no-job";
    const name = s.job?.name ?? "No job";
    const dur = shiftDurationMs(s, now);
    let job = byJob.get(id);
    if (!job) {
      job = { name, ms: 0, workers: new Map() };
      byJob.set(id, job);
    }
    job.ms += dur;
    const wid = s.user?.id ?? "unknown";
    let w = job.workers.get(wid);
    if (!w) {
      w = { name: s.user?.full_name ?? "Unknown", shifts: [], ms: 0 };
      job.workers.set(wid, w);
    }
    w.shifts.push(s);
    w.ms += dur;
  }
  const jobs = Array.from(byJob.values()).sort((a, b) => b.ms - a.ms);

  // ---- CSV export rows for the selected week ----
  const exportRows: ExportRow[] = weekShifts.map((s) => ({
    person: s.user?.full_name ?? "—",
    job: s.job?.name ?? "—",
    costCode: s.cost_code ? `${s.cost_code.code} · ${s.cost_code.name}` : "",
    clockIn: new Date(s.clock_in_at).toLocaleString(),
    clockOut: s.clock_out_at
      ? new Date(s.clock_out_at).toLocaleString()
      : "(still on clock)",
    hours: (shiftDurationMs(s, now) / 3_600_000).toFixed(2),
    note: s.note ?? "",
  }));

  function shiftLine(s: Joined) {
    const dur = shiftDurationMs(s, now);
    return (
      <div key={s.id} className="pl-3 py-1.5 border-l-2 border-gray-100">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-gray-700 truncate">
            {new Date(s.clock_in_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            {" · "}
            {new Date(s.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {s.clock_out_at ? (
              <>
                {" → "}
                {new Date(s.clock_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </>
            ) : (
              <span className="text-green-600"> · still on</span>
            )}
            {s.cost_code && <span className="text-blue-600"> · {s.cost_code.code}</span>}
          </p>
          <span className="font-mono text-xs font-semibold text-gray-700 tabular-nums flex-shrink-0">
            {fmtDuration(dur)}
          </span>
        </div>
        {s.note && <p className="text-xs text-gray-400 truncate">{s.note}</p>}
        {typeof s.lat === "number" && typeof s.lng === "number" && (
          <a
            href={`https://www.google.com/maps?q=${s.lat},${s.lng}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600"
          >
            <MapPin className="w-3 h-3" /> {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Time" subtitle="Weekly breakdown" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-lg p-3 shadow-sm text-center">
            <p className="text-[10px] uppercase font-semibold text-gray-500">On the clock now</p>
            <p className="text-2xl font-bold text-gray-900 mt-0.5">{onClockRows.length}</p>
            <p className="text-[10px] text-gray-400">people working</p>
          </div>
          <div className="bg-white rounded-lg p-3 shadow-sm text-center">
            <p className="text-[10px] uppercase font-semibold text-gray-500">This week&rsquo;s hours</p>
            <p className="text-2xl font-bold text-blue-700 mt-0.5">{weekHours.toFixed(1)}</p>
            <p className="text-[10px] text-gray-400">{workers.length} people</p>
          </div>
        </div>

        {/* On the clock now */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
            <Users className="w-4 h-4" />
            On the Clock Now
          </h2>
          {onClockRows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Briefcase}
                title="Nobody is clocked in"
                description="Crew clock in from the Time tab on their phone."
              />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {onClockRows.map((r) => {
                const elapsed = now - new Date(r.clock_in_at).getTime();
                return (
                  <div key={r.id} className="p-3 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {r.user?.full_name ?? "—"}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{r.job?.name ?? "—"}</p>
                      {typeof r.lat === "number" && (
                        <a
                          href={`https://www.google.com/maps?q=${r.lat},${r.lng}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600"
                        >
                          <MapPin className="w-3 h-3" /> map
                        </a>
                      )}
                    </div>
                    <span className="font-mono text-sm font-semibold text-gray-700 tabular-nums">
                      {fmtDuration(elapsed)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Week navigator */}
        <section className="bg-white rounded-lg shadow-sm p-3 flex items-center justify-between">
          <Link
            href={`/time?weekStart=${prevWeek}`}
            className="p-2 text-gray-600 active:text-gray-900"
            title="Previous week"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div className="text-center">
            <p className="text-xs uppercase font-semibold text-gray-500">Week of</p>
            <p className="text-sm font-semibold text-gray-900">{weekLabel}</p>
          </div>
          {isCurrentWeek ? (
            <span className="w-9 text-center text-[10px] text-gray-400">this</span>
          ) : (
            <Link
              href={`/time?weekStart=${nextWeek}`}
              className="p-2 text-gray-600 active:text-gray-900"
              title="Next week"
            >
              <ChevronRight className="w-5 h-5" />
            </Link>
          )}
        </section>

        <TimeExportButton rows={exportRows} />

        {/* By worker */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
            <User className="w-4 h-4" />
            By Worker
          </h2>
          {workers.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Inbox}
                title="No shifts this week"
                description="Completed shifts will show up here once crew clock out."
              />
            </div>
          ) : (
            <div className="space-y-2">
              {workers.map((w) => (
                <div key={w.name} className="bg-white rounded-lg shadow-sm p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900 truncate">{w.name}</p>
                    <span className="font-mono text-sm font-bold text-blue-700 tabular-nums">
                      {fmtDuration(w.ms)}
                    </span>
                  </div>
                  <div className="mt-2 space-y-0.5">
                    {w.shifts.map(shiftLine)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* By job */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
            <Briefcase className="w-4 h-4" />
            By Job
          </h2>
          {jobs.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Briefcase}
                title="No job activity this week"
                description="Jobs with crew time this week will be grouped here."
              />
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((j) => (
                <div key={j.name} className="bg-white rounded-lg shadow-sm p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900 truncate">{j.name}</p>
                    <span className="font-mono text-sm font-bold text-gray-800 tabular-nums">
                      {fmtDuration(j.ms)}
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {j.workers.size} worker{j.workers.size === 1 ? "" : "s"}
                  </p>
                  <div className="mt-2 space-y-2">
                    {Array.from(j.workers.values()).map((w) => (
                      <div key={w.name}>
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium text-gray-700 truncate">{w.name}</p>
                          <span className="font-mono text-xs font-semibold text-gray-600 tabular-nums">
                            {fmtDuration(w.ms)}
                          </span>
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {w.shifts.map(shiftLine)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}