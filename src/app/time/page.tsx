import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import TimeExportButton, { type ExportRow } from "@/components/TimeExportButton";
import { Clock, Users, MapPin } from "lucide-react";

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default async function TimeOverviewPage() {
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

  // Who's on the clock right now (office sees all via RLS)
  const { data: onClock } = await supabase
    .from("time_entries")
    .select(
      "id, clock_in_at, lat, lng, user:profiles(full_name), job:jobs(name), cost_code:cost_codes(code, name)"
    )
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false });

  // Recent completed shifts
  const { data: recent } = await supabase
    .from("time_entries")
    .select(
      "id, clock_in_at, clock_out_at, note, user:profiles(full_name), job:jobs(name), cost_code:cost_codes(code, name)"
    )
    .not("clock_out_at", "is", null)
    .order("clock_out_at", { ascending: false })
    .limit(100);

  const now = Date.now();

  type Joined = {
    id: string;
    clock_in_at: string;
    clock_out_at: string | null;
    note: string | null;
    lat: number | null;
    lng: number | null;
    user: { full_name: string | null } | null;
    job: { name: string | null } | null;
    cost_code: { code: string; name: string } | null;
  };

  const onClockRows = (onClock ?? []) as unknown as Joined[];
  const recentRows = (recent ?? []) as unknown as Joined[];

  // Today's total hours from completed shifts + currently-open
  const completedMs = recentRows
    .filter((r) => {
      const d = new Date(r.clock_out_at!).toDateString();
      return d === new Date(now).toDateString();
    })
    .reduce((sum, r) => sum + (new Date(r.clock_out_at!).getTime() - new Date(r.clock_in_at).getTime()), 0);
  const openMs = onClockRows.reduce((sum, r) => sum + (now - new Date(r.clock_in_at).getTime()), 0);
  const todayHours = (completedMs + openMs) / 3_600_000;

  const exportRows: ExportRow[] = recentRows.map((r) => ({
    person: r.user?.full_name ?? "—",
    job: r.job?.name ?? "—",
    costCode: r.cost_code ? `${r.cost_code.code} · ${r.cost_code.name}` : "",
    clockIn: new Date(r.clock_in_at).toLocaleString(),
    clockOut: new Date(r.clock_out_at!).toLocaleString(),
    hours: ((new Date(r.clock_out_at!).getTime() - new Date(r.clock_in_at).getTime()) / 3_600_000).toFixed(2),
    note: r.note ?? "",
  }));

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Time" subtitle="Who's on the clock" />

      <main className="max-w-md mx-auto p-4 space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-lg p-3 shadow-sm text-center">
            <p className="text-[10px] uppercase font-semibold text-gray-500">On the clock now</p>
            <p className="text-2xl font-bold text-gray-900 mt-0.5">{onClockRows.length}</p>
            <p className="text-[10px] text-gray-400">people working</p>
          </div>
          <div className="bg-white rounded-lg p-3 shadow-sm text-center">
            <p className="text-[10px] uppercase font-semibold text-gray-500">Today's hours</p>
            <p className="text-2xl font-bold text-blue-700 mt-0.5">{todayHours.toFixed(1)}</p>
            <p className="text-[10px] text-gray-400">logged today</p>
          </div>
        </div>

        <TimeExportButton rows={exportRows} />

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
                      {r.cost_code && (
                        <p className="text-xs text-blue-600 truncate">
                          {r.cost_code.code} · {r.cost_code.name}
                        </p>
                      )}
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

        {/* Recent shifts */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
            <Clock className="w-4 h-4" />
            Recent Shifts
          </h2>
          {recentRows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Inbox}
                title="No shifts yet"
                description="Completed shifts will show up here once crew clock out."
              />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {recentRows.map((r) => {
                const dur = new Date(r.clock_out_at!).getTime() - new Date(r.clock_in_at).getTime();
                return (
                  <div key={r.id} className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {r.user?.full_name ?? "—"}
                        </p>
                        <p className="text-xs text-gray-500 truncate">{r.job?.name ?? "—"}</p>
                      </div>
                      <span className="font-mono text-sm font-semibold text-gray-700 tabular-nums">
                        {fmtDuration(dur)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(r.clock_in_at).toLocaleDateString([], { month: "short", day: "numeric" })} ·{" "}
                      {new Date(r.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {" → "}
                      {new Date(r.clock_out_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {r.cost_code && (
                        <span className="text-blue-600"> · {r.cost_code.code}</span>
                      )}
                    </p>
                    {r.note && <p className="text-xs text-gray-500 mt-0.5 truncate">{r.note}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}