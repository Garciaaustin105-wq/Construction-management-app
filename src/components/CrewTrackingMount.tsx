"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isLawn } from "@/lib/variant";
import { FIELD, MANAGEMENT, type Role } from "@/lib/roles";
import { useCrewLocationBroadcast } from "@/lib/useCrewLocationBroadcast";
import { CLOCK_CHANGED_EVENT } from "@/lib/crewTracking";
import { toISODate } from "@/lib/weekUtils";
import type { GeoStop } from "@/lib/geofence";

// Mounts the crew location broadcaster in the PERSISTENT chrome (Providers), so
// it survives navigation.
//
// This exists because the first cut mounted the hook on /crew/time, which was
// wrong in a way that would have looked like the feature simply didn't work:
// crew clock in and then immediately navigate away to My Route to do the actual
// job. Unmounting the time page tore the channel down and broadcast OFFLINE, so
// the office map would have read "3 on shift, 0 sharing location" almost all
// day — the one state that makes a tracking feature useless.
//
// Cost: ONE pair of queries per session, not per navigation. Providers does not
// remount as the user moves around, so this component mounts once and stays.
// `orgId` and `role` come free from the layout's already-cached getMe().
//
// Clock-in/out is picked up via a window event the time page dispatches, rather
// than by polling — this app has been burned by background polls before, and a
// poll here would run on every page for every field user all day.

type Props = {
  orgId: string | null;
  role: Role | null;
};

type StopRow = {
  id: string;
  route_order: number | null;
  jobs: {
    lawn_jobs: { map_lat: number | null; map_lng: number | null } | null;
  } | null;
};

// Anyone who can clock in can be tracked — the same union /crew/time admits.
function canClockIn(role: Role | null): boolean {
  if (!role) return false;
  return FIELD.has(role) || MANAGEMENT.has(role);
}

// Today's geofenceable stops for this user.
//
// SCOPING MIRRORS MY ROUTE ON PURPOSE. A stop the geofence may auto-stamp must
// be a stop the crew member can see and undo, or an automatic action becomes an
// action nobody can explain. Crew/superintendent get visits assigned to them; a
// solo office/admin owner (an org with zero crew_members) also gets unassigned
// visits, exactly as My Route does. An office/admin who DOES have crew is a
// dispatcher, not a field worker — they get no stops, so driving past a job
// never stamps it.
//
// Narrower than My Route in two ways, both deliberate:
//   * TODAY ONLY. My Route shows a 14-day horizon so crews can look ahead;
//     acting on next week's visit because you happened to drive past it is not
//     a feature.
//   * PENDING ONLY. A done or skipped visit is settled. Re-firing on it would
//     at best be a no-op and at worst reopen a decision a human already made.
//
// Visits with no map pin are dropped rather than guessed at — they simply fall
// back to the manual Start/Done buttons, which is the documented contract in
// useCrewLocationBroadcast's `stops` option.
async function loadTodaysStops(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  role: Role | null
): Promise<GeoStop[]> {
  const crewLike = role === "crew" || role === "superintendent";

  let solo = false;
  if (!crewLike) {
    // Linked logins only — see the matching guard on My Route. A placeholder
    // crew_member with no account must not demote a solo owner to dispatcher.
    const { count } = await supabase
      .from("crew_members")
      .select("id", { count: "exact", head: true })
      .not("user_id", "is", null);
    solo = (count ?? 0) === 0;
    // Office/admin with a real crew: dispatcher, not field. No stops.
    if (!solo) return [];
  }

  // Local date, not toISOString(). due_date is a DATE the office set in their
  // own calendar terms; taking the UTC date would silently roll over to
  // tomorrow's route for every crew west of Greenwich each evening.
  const today = toISODate(new Date());

  let q = supabase
    .from("lawn_visits")
    .select("id, route_order, jobs(lawn_jobs(map_lat, map_lng))")
    .eq("status", "pending")
    .eq("due_date", today);
  q = solo
    ? q.or(`crew_id.eq.${userId},crew_id.is.null`)
    : q.eq("crew_id", userId);

  const { data } = await q;
  const rows = (data as unknown as StopRow[] | null) ?? [];

  return rows.flatMap((r) => {
    const pin = r.jobs?.lawn_jobs;
    if (!pin || pin.map_lat === null || pin.map_lng === null) return [];
    return [
      {
        id: r.id,
        lat: pin.map_lat,
        lng: pin.map_lng,
        routeOrder: r.route_order,
      },
    ];
  });
}

export default function CrewTrackingMount({ orgId, role }: Props) {
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [clockedIn, setClockedIn] = useState(false);
  const [stops, setStops] = useState<GeoStop[]>([]);

  // Lawn-only, and only for roles that can hold a shift. Construction and
  // office-only roles never even run the effect below.
  const eligible = isLawn() && canClockIn(role) && !!orgId;

  const refresh = useCallback(async () => {
    if (!eligible) return;
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const [profileRes, openRes] = await Promise.all([
      supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
      supabase
        .from("time_entries")
        .select("id")
        .eq("user_id", user.id)
        .is("clock_out_at", null)
        .limit(1),
    ]);
    setName((profileRes.data?.full_name as string | null) ?? null);

    const onShift = ((openRes.data as { id: string }[] | null) ?? []).length > 0;
    setClockedIn(onShift);

    // The route is loaded AT CLOCK-IN, not on a timer. A crew's stops for the
    // day are settled by the time they start, and this component is explicitly
    // built to avoid background polling. Clocking out clears them so a phone
    // left in a truck cannot stamp anything.
    setStops(onShift ? await loadTodaysStops(supabase, user.id, role) : []);
  }, [eligible, role]);

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) void refresh();
    };
    // The initial read is deferred to a microtask rather than called straight
    // from the effect body. refresh() only setStates after awaits, so it is
    // never synchronous in practice — but calling it directly reads as a
    // cascading render to both a reviewer and the lint rule, and the deferral
    // states the intent instead of suppressing the warning.
    queueMicrotask(run);
    // Updates come from the time clock, which fires this on clock in and clock
    // out — so tracking starts and stops immediately with nothing polling.
    window.addEventListener(CLOCK_CHANGED_EVENT, run);
    return () => {
      cancelled = true;
      window.removeEventListener(CLOCK_CHANGED_EVENT, run);
    };
  }, [eligible, refresh]);

  useCrewLocationBroadcast({
    enabled: eligible && clockedIn,
    orgId,
    userId,
    name,
    stops,
  });

  return null;
}
