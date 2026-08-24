import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Stamp started_at = now() on a lawn visit, server-side. Mirrors the /status
// route's auth: office/PM, or crew/superintendent on their OWN visit. The visit
// page used to write started_at directly from the browser — RLS permits that
// for office + the assigned crew and the guard trigger allows the column, but a
// client-stamped timestamp is tamper-able and the "only when pending + not
// already started" preconditions lived only in the UI. Routing it here makes the
// timestamp server-authoritative (matches completed_at, which /status stamps
// server-side) and centralises the preconditions.
//
// "Start" does NOT change visit status — status stays 'pending'; the lifecycle
// (src/lib/lifecycles/lawn-visit.ts) is untouched. On-site time is
// completed_at - started_at. No customer notification fires on start (none
// should — only on done/skipped, which /status handles).

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const user = me.user;

  const role = me.hasProfile ? me.role : null;
  const officeLike = !!role && OFFICE_OR_PM.has(role as never);
  // Crew / superintendent may start their own visit (same audience as /status
  // for status changes). Office/PM oversee every org visit via RLS.
  const crewLike = role === "crew" || role === "superintendent";
  if (!officeLike && !crewLike) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { data: current } = await supabase
    .from("lawn_visits")
    .select("id, status, started_at, crew_id")
    .eq("id", id)
    .maybeSingle();
  const cur = current as unknown as {
    id: string;
    status: string;
    started_at: string | null;
    crew_id: string | null;
  } | null;
  if (!cur) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }
  // Defense in depth: a crew/superintendent caller may only start a visit
  // assigned to them (the page also checks this client-side). Office/PM
  // oversee every org visit via RLS (tier_office_or_pm).
  if (crewLike && cur.crew_id !== user.id) {
    return NextResponse.json({ error: "Not your visit" }, { status: 403 });
  }

  // Idempotent: already started -> return the existing stamp, no re-stamp (a
  // retry or a double-tap must not move the start time).
  if (cur.started_at) {
    return NextResponse.json({ ok: true, started_at: cur.started_at });
  }
  // Only a pending visit can be started (done/skipped/paused cannot).
  if (cur.status !== "pending") {
    return NextResponse.json(
      { error: "Only a pending visit can be started" },
      { status: 409 }
    );
  }

  const startedAt = new Date().toISOString();
  const { error } = await supabase
    .from("lawn_visits")
    .update({ started_at: startedAt })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, started_at: startedAt });
}