import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import { OFFICE_LIKE } from "@/lib/roles";
import RoutePlanner from "@/components/RoutePlanner";
import type { RouteStop, CrewInfo } from "@/lib/lawnRouting";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";

// Office route planner: clusters the day's lawn visits into geographic zones
// (from lawn_jobs map pins) + nearest-neighbor ordering, so a dispatcher can
// balance crews and save an optimized sequence. Crew read is scoped by RLS; the
// planner page itself is OFFICE_LIKE only. The map pin comes through the
// jobs → lawn_jobs 1:1 (lawn_jobs.id references jobs.id), so the embed
// jobs(..., lawn_jobs(map_lat, map_lng)) nests correctly (reverse-FK).

type VisitRow = {
  id: string;
  due_date: string;
  status: string;
  crew_id: string | null;
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
    lawn_jobs: { map_lat: number | null; map_lng: number | null } | null;
  } | null;
  recurring_schedules: { service_type: string | null } | null;
};
type CrewRow = { id: string; full_name: string | null; email: string | null };

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function LawnRoutesPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;

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
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const [{ data: visitRows }, { data: crewRows }] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select(
        "id, due_date, status, crew_id, jobs(name, address, customers(name), lawn_jobs(map_lat, map_lng)), recurring_schedules(service_type)"
      )
      .eq("due_date", date)
      .order("status", { ascending: true }),
    supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("role", ["crew", "superintendent"])
      .order("full_name", { ascending: true }),
  ]);

  const stops: RouteStop[] = ((visitRows as unknown as VisitRow[]) ?? []).map(
    (v) => {
      const lj = v.jobs?.lawn_jobs ?? null;
      return {
        id: v.id,
        jobName: v.jobs?.name ?? "—",
        address: v.jobs?.address ?? null,
        customerName: v.jobs?.customers?.name ?? null,
        serviceType: v.recurring_schedules?.service_type ?? null,
        crewId: v.crew_id,
        status: v.status,
        dueDate: v.due_date,
        pos:
          lj && lj.map_lat != null && lj.map_lng != null
            ? { lat: Number(lj.map_lat), lng: Number(lj.map_lng) }
            : null,
      };
    }
  );

  const crews: CrewInfo[] = ((crewRows as unknown as CrewRow[]) ?? []).map(
    (c) => ({ id: c.id, name: c.full_name || c.email || "Crew" })
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Route Planner" subtitle="Zone grouping + optimized order" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <Link
          href="/lawn"
          className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Lawn
        </Link>

        {/* Date nav */}
        <div className="flex items-center justify-between bg-white rounded-lg p-2 shadow-sm">
          <Link
            href={`/lawn/routes?date=${shiftDate(date, -1)}`}
            className="flex items-center gap-1 text-sm text-gray-700 font-medium px-2 py-1 rounded active:bg-gray-100"
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </Link>
          {date !== today ? (
            <Link
              href="/lawn/routes"
              className="text-sm text-green-700 font-semibold px-2 py-1 rounded active:bg-green-50"
            >
              Today
            </Link>
          ) : (
            <span className="text-sm text-gray-400 font-medium px-2 py-1">
              Today
            </span>
          )}
          <Link
            href={`/lawn/routes?date=${shiftDate(date, 1)}`}
            className="flex items-center gap-1 text-sm text-gray-700 font-medium px-2 py-1 rounded active:bg-gray-100"
          >
            Next <ChevronRight className="w-4 h-4" />
          </Link>
        </div>

        {/* key={date} remounts the planner so local crew-assignment state
            resets cleanly when the dispatcher changes days. */}
        <RoutePlanner key={date} date={date} stops={stops} crews={crews} />
      </main>
    </div>
  );
}