"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isLawn } from "@/lib/variant";
import { FIELD, MANAGEMENT, type Role } from "@/lib/roles";
import { useCrewLocationBroadcast } from "@/lib/useCrewLocationBroadcast";
import { CLOCK_CHANGED_EVENT } from "@/lib/crewTracking";

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

// Anyone who can clock in can be tracked — the same union /crew/time admits.
function canClockIn(role: Role | null): boolean {
  if (!role) return false;
  return FIELD.has(role) || MANAGEMENT.has(role);
}

export default function CrewTrackingMount({ orgId, role }: Props) {
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [clockedIn, setClockedIn] = useState(false);

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
    setClockedIn(((openRes.data as { id: string }[] | null) ?? []).length > 0);
  }, [eligible]);

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
  });

  return null;
}
