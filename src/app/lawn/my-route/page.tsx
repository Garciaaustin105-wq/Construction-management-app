"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import { useToast } from "@/components/Toast";
import { Loader2, Check, CalendarDays, Sprout, Camera, Navigation } from "lucide-react";
import type { RouteStop } from "@/lib/lawnRouting";

// Google Maps touches window — load the map client-only.
const GoogleRouteMap = dynamic(() => import("@/components/GoogleRouteMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[300px] rounded-lg bg-gray-100 animate-pulse" />
  ),
});

// Field crew's own route. Lists lawn_visits where crew_id = the signed-in crew
// member (crew / superintendent), grouped Overdue / Today / Upcoming. Crew
// marks a visit done inline through the /status API (NOT a direct RLS update)
// so the customer notification suite (service_complete + review_request) fires
// exactly as it does from the visit detail page — a direct update would
// silently skip both emails. The /status route admits crew/super for
// status-only changes and server-checks crew_id === auth.uid(). Tapping a card
// opens the visit page for before/after photos + details (opened to crew for
// their own visits).
//
// A read-only Google driving-path map of today's pinned stops sits above the
// list, with an "Open in Google Maps" link that launches turn-by-turn nav.

type Visit = {
  id: string;
  job_id: string;
  due_date: string;
  status: string;
  route_order: number | null;
  // customers reached through jobs (lawn_visits has job_id, no customer_id).
  // lawn_jobs carries the map pin (map_lat/map_lng) set by the office planner.
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
    lawn_jobs: { map_lat: number | null; map_lng: number | null } | null;
  } | null;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

function dueLabel(due: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (due < today) return "Overdue";
  if (due === today) return "Today";
  const t = new Date(`${due}T00:00:00.000Z`);
  return t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function VisitCard({
  v,
  busyId,
  onDone,
}: {
  v: Visit;
  busyId: string | null;
  onDone: (id: string) => void;
}) {
  const jobName = v.jobs?.name ?? "—";
  const custName = v.jobs?.customers?.name ?? null;
  const address = v.jobs?.address ?? null;
  return (
    <div className="bg-white rounded-lg p-3 shadow-sm space-y-2">
      <div className="flex justify-between items-start gap-2">
        <Link href={`/lawn/visits/${v.id}`} className="min-w-0 flex-1 active:opacity-70">
          <p className="font-semibold text-gray-900 truncate">{jobName}</p>
          <p className="text-xs text-gray-500 truncate">
            {custName ? `${custName} · ` : ""}
            {address ?? "—"}
          </p>
        </Link>
        <span
          className={`text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap ${
            STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {dueLabel(v.due_date)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDone(v.id)}
          disabled={busyId === v.id}
          className="flex-1 bg-green-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {busyId === v.id ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Mark done
        </button>
        <Link
          href={`/lawn/visits/${v.id}`}
          className="bg-white border border-gray-300 text-gray-900 py-2 px-3 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-1.5"
        >
          <Camera className="w-4 h-4" />
          Photos
        </Link>
      </div>
    </div>
  );
}

function Section({
  label,
  list,
  icon,
  busyId,
  onDone,
}: {
  label: string;
  list: Visit[];
  icon: React.ReactNode;
  busyId: string | null;
  onDone: (id: string) => void;
}) {
  if (list.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
        {icon}
        {label} ({list.length})
      </h2>
      <div className="space-y-2">
        {list.map((v) => (
          <VisitCard key={v.id} v={v} busyId={busyId} onDone={onDone} />
        ))}
      </div>
    </section>
  );
}

// Google Maps' dir URL caps at 9 stops total (origin + up to 8 waypoints-ish).
// Slice before splitting so a long day still produces a valid nav link.
const MAX_DIR_STOPS = 9;

export default function MyRoutePage() {
  const router = useRouter();
  const toast = useToast();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      if (role !== "crew" && role !== "superintendent") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      // My pending visits due within the next 14 days (RLS crew-read keyed on
      // crew_id = auth.uid() admits exactly my rows). Nests the job's map pin
      // (lawn_jobs) so the driving-path map can plot today's stops.
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 14);
      const horizonDate = horizon.toISOString().slice(0, 10);
      const { data: rows } = await supabase
        .from("lawn_visits")
        .select(
          "id, job_id, due_date, status, route_order, jobs(name, address, customers(name), lawn_jobs(map_lat, map_lng))"
        )
        .eq("crew_id", user.id)
        .eq("status", "pending")
        .lte("due_date", horizonDate)
        .order("due_date", { ascending: true })
        .order("route_order", { ascending: true, nullsFirst: false });
      setVisits((rows as unknown as Visit[]) ?? []);
    })();
  }, [router]);

  async function markDone(visitId: string) {
    setBusyId(visitId);
    // Route through the /status API (not a direct RLS update) so the customer
    // service_complete / review_request emails fire — the same path the visit
    // detail page takes. The route admits crew/super for status-only changes
    // and server-checks crew_id === auth.uid().
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visitId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
    } catch {
      setBusyId(null);
      toast.error("Failed: network error");
      return;
    }
    setBusyId(null);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    setVisits((prev) => prev.filter((v) => v.id !== visitId));
    toast.success("Marked done");
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdue = visits.filter((v) => v.due_date < today);
  const todays = visits.filter((v) => v.due_date === today);
  const upcoming = visits.filter((v) => v.due_date > today);

  // Today's stops that have a map pin, as RouteStop[] for the driving-path map.
  const todayStops: RouteStop[] = todays
    .map((v): RouteStop | null => {
      const lj = v.jobs?.lawn_jobs;
      if (!lj || lj.map_lat == null || lj.map_lng == null) return null;
      return {
        id: v.id,
        jobId: v.job_id,
        jobName: v.jobs?.name ?? "—",
        address: v.jobs?.address ?? null,
        customerName: v.jobs?.customers?.name ?? null,
        serviceType: null,
        crewId: null,
        status: v.status,
        dueDate: v.due_date,
        pos: { lat: Number(lj.map_lat), lng: Number(lj.map_lng) },
        routeOrder: v.route_order,
      };
    })
    .filter((s): s is RouteStop => s !== null);

  // Turn-by-turn nav link: origin = first stop, destination = last, middle as
  // waypoints. Capped to MAX_DIR_STOPS so the URL stays valid.
  const capped = todayStops.slice(0, MAX_DIR_STOPS);
  const dirUrl =
    capped.length >= 2
      ? `https://www.google.com/maps/dir/?api=1&origin=${capped[0].pos!.lat},${capped[0].pos!.lng}&destination=${capped[capped.length - 1].pos!.lat},${capped[capped.length - 1].pos!.lng}&waypoints=${capped
          .slice(1, -1)
          .map((s) => `${s.pos!.lat},${s.pos!.lng}`)
          .join("|")}&travelmode=driving`
      : null;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="My Route" subtitle="Your assigned lawn visits" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-6">
        {visits.length === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={Sprout}
              title="No visits assigned to you"
              description="Lawn visits the office assigns to you will show up here, grouped by day."
            />
          </div>
        ) : (
          <>
            {todayStops.length >= 2 && (
              <div className="space-y-2">
                <GoogleRouteMap stops={todayStops} readOnly showDirections />
                {dirUrl && (
                  <a
                    href={dirUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-green-600 text-white py-2 px-3 rounded-lg font-semibold text-sm active:bg-green-700"
                  >
                    <Navigation className="w-4 h-4" /> Open in Google Maps
                  </a>
                )}
              </div>
            )}
            <Section
              label="Overdue"
              list={overdue}
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              busyId={busyId}
              onDone={markDone}
            />
            <Section
              label="Today"
              list={todays}
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              busyId={busyId}
              onDone={markDone}
            />
            <Section
              label="Upcoming"
              list={upcoming}
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              busyId={busyId}
              onDone={markDone}
            />
          </>
        )}
      </main>
    </div>
  );
}