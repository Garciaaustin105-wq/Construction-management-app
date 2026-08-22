import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";

// POST /api/lawn/visits/bulk-assign — set (or clear) the crew on a set of
// visits, e.g. a future cross-day "reassign these to someone else" entry
// point. Mirrors bulk-move: office-only, RLS-scoped, best-effort per row so
// one bad id doesn't fail the whole batch.
//
// NOTE: the /lawn/routes planner's own "Assign to all / Assign to
// unassigned" buttons do NOT call this route — they mutate local
// crewAssign state and go through the planner's existing save(), which
// renumbers route_order per-crew contiguously from the current list order.
// Calling this route from the planner too would double-write route_order
// with two different numbering schemes. This route nulls route_order (a
// crew reassignment invalidates whatever sequence existed for the OLD crew)
// and leaves re-sequencing to a subsequent planner visit, same as bulk-move.
export const dynamic = "force-dynamic";

type VisitRow = { id: string; jobs: { name: string } | null };

export async function POST(req: Request) {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = me.role;
  if (!OFFICE_LIKE.has(role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { visit_ids?: string[]; crew_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const visitIds = Array.isArray(body.visit_ids) ? body.visit_ids : [];
  if (visitIds.length === 0)
    return NextResponse.json({ error: "visit_ids is required" }, { status: 400 });
  const crewId = body.crew_id ?? null;

  // RLS scopes to this org — a cross-org id in the list simply doesn't come
  // back / doesn't update.
  const { data: visits } = await supabase
    .from("lawn_visits")
    .select("id, jobs(name)")
    .in("id", visitIds);
  const visitRows = (visits as unknown as VisitRow[] | null) ?? [];

  let assigned = 0;
  const failed: { jobName: string }[] = [];

  for (const v of visitRows) {
    const { error } = await supabase
      .from("lawn_visits")
      .update({ crew_id: crewId, route_order: null })
      .eq("id", v.id);
    if (error) {
      console.error("bulk-assign update failed", error.code, error.message);
      failed.push({ jobName: v.jobs?.name ?? "—" });
    } else {
      assigned += 1;
    }
  }

  return NextResponse.json({ assigned, failed });
}
