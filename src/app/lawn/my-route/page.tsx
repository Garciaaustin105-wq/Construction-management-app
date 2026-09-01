"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { todayInZone, formatDueStamp, DEFAULT_TIME_ZONE } from "@/lib/orgDate";
import PageContainer from "@/components/PageContainer";
import EmptyState from "@/components/EmptyState";
import { useToast } from "@/components/Toast";
import { Loader2, Check, CalendarDays, Sprout, Camera, Navigation, X, Play, Undo2 } from "lucide-react";
import type { RouteStop } from "@/lib/lawnRouting";

// Google Maps touches window — load the map client-only.
const GoogleRouteMap = dynamic(() => import("@/components/GoogleRouteMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[300px] rounded-lg bg-gray-100 animate-pulse" />
  ),
});

// Only mounts after the crew taps "Skip" — kept out of the first-load bundle.
const SkipReasonPicker = dynamic(
  () => import("@/components/SkipReasonPicker"),
  {
    ssr: false,
    loading: () => (
      <div className="h-[104px] rounded-lg bg-amber-50 border border-amber-200 animate-pulse" />
    ),
  }
);

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
// Solo-owner field mode: an office/admin with ZERO crew_members is admitted
// here as the field worker — unassigned visits (crew_id is null) count as
// theirs, plus any visits they self-assigned (crew_id = their own id). /status
// already admits office/admin (officeLike), so one-tap done/skip + the
// customer notification suite fire unchanged; the crew_id===auth.uid() guard
// only applies to crew/super callers, not to the office/admin owner. The
// moment the org adds a crew_member, the owner reverts to dispatcher and is
// bounced to /dashboard (the Route Planner is their tool).
//
// A read-only Google driving-path map of today's pinned stops sits above the
// list, with an "Open in Google Maps" link that launches turn-by-turn nav.

type Visit = {
  id: string;
  job_id: string;
  due_date: string;
  status: string;
  route_order: number | null;
  // Set when the crew starts the visit. Paired with completed_at it is what
  // makes a visit DURATION possible — which is the whole reason Start exists.
  started_at: string | null;
  completed_at: string | null;
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

// `today` is passed in, computed in the ORGANISATION's timezone. It used to be
// new Date().toISOString().slice(0,10) — the UTC date — which from 20:00
// Eastern each evening is already tomorrow, so for four hours every night this
// screen labelled today's remaining work "Overdue" and tomorrow's "Today".
function dueLabel(due: string, today: string): string {
  if (due < today) return `Overdue · was due ${formatDueStamp(due)}`;
  if (due === today) return "Today";
  return formatDueStamp(due);
}

/** "12m" / "1h 05m" since a visit was started. Coarse on purpose — the crew
 *  needs to see the clock is running, not a stopwatch. */
function sinceLabel(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function VisitCard({
  v,
  today,
  busyId,
  onStart,
  onDone,
  onSkip,
  onReopen,
}: {
  today: string;
  v: Visit;
  busyId: string | null;
  onStart: (id: string) => void;
  onDone: (id: string) => void;
  onSkip: (id: string, reason: string) => void;
  onReopen: (id: string) => void;
}) {
  const [showSkip, setShowSkip] = useState(false);
  const jobName = v.jobs?.name ?? "—";
  const custName = v.jobs?.customers?.name ?? null;
  const address = v.jobs?.address ?? null;
  const busy = busyId === v.id;
  return (
    <div className="bg-white rounded-lg p-3 shadow-sm space-y-2">
      <div className="flex justify-between items-start gap-2">
        <Link href={`/lawn/visits/${v.id}?from=route`} className="min-w-0 flex-1 active:opacity-70">
          <p className="font-semibold text-gray-900 truncate">{jobName}</p>
          <p className="text-xs text-gray-500 truncate">
            {custName ? `${custName} · ` : ""}
            {address ?? "—"}
          </p>
        </Link>
        <span
          className={`text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap ${
            v.started_at
              ? "bg-blue-100 text-blue-700"
              : (STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600")
          }`}
        >
          {v.started_at ? `On site ${sinceLabel(v.started_at)}` : dueLabel(v.due_date, today)}
        </span>
      </div>
      {v.status === "done" || v.status === "skipped" ? (
        /* Finished. Shown rather than removed so an AUTOMATIC stamp is visible
           and reversible — the geofence can pick a neighbour within GPS error,
           or fire because someone parked to take a call. */
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm text-gray-500">
            {v.status === "done" ? "Completed" : "Skipped"}
            {v.completed_at
              ? ` · ${new Date(v.completed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : ""}
            {v.status === "done" && v.started_at && v.completed_at
              ? ` · ${Math.max(1, Math.round((new Date(v.completed_at).getTime() - new Date(v.started_at).getTime()) / 60000))} min`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => onReopen(v.id)}
            disabled={busy}
            className="bg-white border border-gray-300 text-gray-700 py-2 px-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
            Undo
          </button>
        </div>
      ) : showSkip ? (
        <SkipReasonPicker
          busy={busy}
          onConfirm={(reason) => onSkip(v.id, reason)}
          onCancel={() => setShowSkip(false)}
        />
      ) : (
        <div className="flex items-center gap-2">
          {/* Start, then Done. Two taps per property instead of one, but it is
              what produces a DURATION — without a start there is only an end
              timestamp, which is why 0 of 239 visits had one. Once started, the
              button becomes Mark done and the card shows the running elapsed
              time so the crew can see it is counting. */}
          {v.started_at ? (
            <button
              type="button"
              onClick={() => onDone(v.id)}
              disabled={busy}
              className="flex-1 bg-green-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              Mark done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onStart(v.id)}
              disabled={busy}
              className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Start
            </button>
          )}
          <Link
            href={`/lawn/visits/${v.id}?from=route`}
            className="bg-white border border-gray-300 text-gray-900 py-2 px-3 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-1.5"
          >
            <Camera className="w-4 h-4" />
            Photos
          </Link>
          <button
            type="button"
            onClick={() => setShowSkip(true)}
            disabled={busy}
            className="bg-white border border-gray-300 text-gray-600 py-2 px-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <X className="w-4 h-4" />
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  list,
  icon,
  busyId,
  onStart,
  onDone,
  onSkip,
  onReopen,
  today,
}: {
  label: string;
  list: Visit[];
  today: string;
  icon: React.ReactNode;
  busyId: string | null;
  onStart: (id: string) => void;
  onDone: (id: string) => void;
  onSkip: (id: string, reason: string) => void;
  onReopen: (id: string) => void;
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
          <VisitCard key={v.id} v={v} today={today} busyId={busyId} onStart={onStart} onDone={onDone} onSkip={onSkip} onReopen={onReopen} />
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
  const [soloMode, setSoloMode] = useState(false);
  // The organisation's IANA zone. Until the profile loads, the safe default
  // keeps grouping stable rather than briefly flashing UTC-based buckets.
  const [orgTz, setOrgTz] = useState<string>(DEFAULT_TIME_ZONE);
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
        .select("role, organizations(timezone)")
        .eq("id", user.id)
        .single();
      const role = profile?.role ?? "crew";
      // Same round trip, no extra query. What counts as "today" belongs to the
      // business, not to the server (UTC) or the phone (wherever it is).
      const orgTz =
        (profile as unknown as { organizations?: { timezone?: string | null } } | null)
          ?.organizations?.timezone ?? DEFAULT_TIME_ZONE;
      setOrgTz(orgTz);

      const crewLike = role === "crew" || role === "superintendent";
      const officeLike = role === "office" || role === "admin";
      // Solo-owner field mode: an office/admin running the work with NO
      // crew_members becomes the field worker — they get the same streamlined
      // My Route a crew gets, and unassigned visits (crew_id is null) count as
      // theirs. The moment the org adds a real crew, the owner reverts to
      // dispatcher (the Route Planner) and is bounced from here. /status
      // already admits office/admin, so one-tap done/skip + the customer
      // notification suite fire unchanged.
      let solo = false;
      if (crewLike) {
        // proceed — field crew / superintendent on their own visits.
      } else if (officeLike) {
        // Only crew_members with a LINKED LOGIN count. A row with a null
        // user_id is a name on a list — nobody can sign in as it, so it cannot
        // be the field worker. Counting it flipped a solo owner to "dispatcher"
        // and bounced them off their own route with no error and no
        // explanation, which is exactly what happened the first time an owner
        // added a placeholder crew member before that person had an account.
        const { count } = await supabase
          .from("crew_members")
          .select("id", { count: "exact", head: true })
          .not("user_id", "is", null);
        solo = (count ?? 0) === 0;
        if (!solo) {
          router.push("/dashboard");
          return;
        }
      } else {
        router.push("/dashboard");
        return;
      }
      setSoloMode(solo);
      setAuthorized(true);

      // My pending visits due within the next 14 days. Crew/super: only visits
      // assigned to me (RLS crew-read keyed on crew_id = auth.uid() also scopes
      // to mine). Solo owner: my own visits + every unassigned visit (there are
      // no crews to own them). Nests the job's map pin (lawn_jobs) so the
      // driving-path map can plot today's stops.
      const horizon = new Date();
      horizon.setDate(horizon.getDate() + 14);
      const horizonDate = horizon.toISOString().slice(0, 10);
      let q = supabase
        .from("lawn_visits")
        .select(
          "id, job_id, due_date, status, route_order, started_at, completed_at, jobs(name, address, customers(name), lawn_jobs(map_lat, map_lng))"
        )
        // Pending AND today's already-finished visits. Finished ones used to be
        // dropped entirely, which was fine when a crew member tapped "done"
        // themselves — but the geofence can now mark a visit done automatically,
        // and an automatic action you cannot see or undo is worse than no
        // automation. They stay visible for the rest of the day with an Undo.
        .in("status", ["pending", "done", "skipped"])
        .lte("due_date", horizonDate);
      if (solo) {
        q = q.or(`crew_id.eq.${user.id},crew_id.is.null`);
      } else {
        q = q.eq("crew_id", user.id);
      }
      const { data: rows } = await q
        .order("due_date", { ascending: true })
        .order("route_order", { ascending: true, nullsFirst: false });
      setVisits((rows as unknown as Visit[]) ?? []);
    })();
  }, [router]);

  // PHASE 2 of the time redesign. /api/lawn/visits/[id]/start already existed
  // and was already server-authoritative — but it was only ever called from the
  // visit DETAIL page, and crews work from this screen. Result: of 239 visits,
  // 6 were completed and 0 had a started_at, so not one visit in the system had
  // a duration. This is the missing caller.
  //
  // Idempotent server-side: starting an already-started visit returns the
  // existing started_at rather than overwriting it, so a double-tap is safe.
  async function markStart(visitId: string) {
    setBusyId(visitId);
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visitId}/start`, { method: "POST" });
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
    const data = (await res.json().catch(() => ({}))) as { started_at?: string };
    setVisits((prev) =>
      prev.map((v) =>
        v.id === visitId
          ? { ...v, started_at: data.started_at ?? new Date().toISOString() }
          : v
      )
    );
    toast.success("Started");
  }

  // Undo an auto-stamp. The geofence can get it wrong — a wrong pin, a
  // neighbour within GPS error, a crew member who parked to take a call. done ->
  // pending is an existing, server-validated transition, and the /status route
  // already admits crew for status-only changes on their own visits, so this
  // needs no new endpoint and no new permission.
  async function reopenVisit(visitId: string) {
    setBusyId(visitId);
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visitId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "pending" }),
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
    setVisits((prev) =>
      prev.map((v) =>
        v.id === visitId ? { ...v, status: "pending", completed_at: null } : v
      )
    );
    toast.success("Reopened");
  }

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
    setVisits((prev) =>
      prev.map((v) =>
        v.id === visitId
          ? { ...v, status: "done", completed_at: new Date().toISOString() }
          : v
      )
    );
    toast.success("Marked done");
  }

  async function skipVisit(visitId: string, skipReason: string) {
    setBusyId(visitId);
    // Same /status API path as markDone — fires the service_skipped customer
    // notice (with the reason) instead of service_complete/review_request, and
    // server-checks crew_id === auth.uid() before applying.
    let res: Response;
    try {
      res = await fetch(`/api/lawn/visits/${visitId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "skipped", skip_reason: skipReason }),
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
    setVisits((prev) =>
      prev.map((v) => (v.id === visitId ? { ...v, status: "skipped" } : v))
    );
    toast.success("Visit skipped");
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  const today = todayInZone(orgTz);
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
        // Crew map only needs pins + the nav link — no ETA walk here.
        serviceDurationMin: null,
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
    <PageContainer title="My Route" subtitle="Your assigned lawn visits" maxWidth="list" mainClassName="space-y-6">
      {soloMode && (
        <p className="text-[11px] text-blue-800 bg-blue-50 border border-blue-200 rounded p-2">
          Solo mode — you have no crews yet, so every unassigned visit shows here
          as yours. Add a crew in the Route Planner to hand visits off.
        </p>
      )}
      {visits.length === 0 ? (
        <div className="bg-white rounded-lg">
          <EmptyState
            icon={Sprout}
            title={soloMode ? "No visits scheduled" : "No visits assigned to you"}
            description={
              soloMode
                ? "Lawn visits coming up in the next 14 days will show up here, grouped by day."
                : "Lawn visits the office assigns to you will show up here, grouped by day."
            }
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
            today={today}
            label="Overdue"
            list={overdue}
            icon={<CalendarDays className="w-3.5 h-3.5" />}
            busyId={busyId}
            onStart={markStart}
            onDone={markDone}
            onSkip={skipVisit}
            onReopen={reopenVisit}
          />
          <Section
            today={today}
            label="Today"
            list={todays}
            icon={<CalendarDays className="w-3.5 h-3.5" />}
            busyId={busyId}
            onStart={markStart}
            onDone={markDone}
            onSkip={skipVisit}
            onReopen={reopenVisit}
          />
          <Section
            today={today}
            label="Upcoming"
            list={upcoming}
            icon={<CalendarDays className="w-3.5 h-3.5" />}
            busyId={busyId}
            onStart={markStart}
            onDone={markDone}
            onSkip={skipVisit}
            onReopen={reopenVisit}
          />
        </>
      )}
    </PageContainer>
  );
}