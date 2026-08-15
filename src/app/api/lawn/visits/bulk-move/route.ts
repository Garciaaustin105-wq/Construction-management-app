import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";

// POST /api/lawn/visits/bulk-move — move ALL of one day's pending lawn visits to
// another date. Schedule + status untouched; only due_date changes. Office-only.
// A visit that already exists on the target date for the same schedule trips
// the UNIQUE(recurring_schedule_id, due_date) constraint (PostgREST code 23505)
// — we skip those and report them as conflicts rather than failing the batch.
export const dynamic = "force-dynamic";

type VisitRow = { id: string; jobs: { name: string } | null };

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!OFFICE_LIKE.has(role as never))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { fromDate?: string; toDate?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { fromDate, toDate } = body;
  if (!fromDate || !toDate)
    return NextResponse.json(
      { error: "fromDate and toDate are required" },
      { status: 400 }
    );
  if (fromDate === toDate)
    return NextResponse.json(
      { error: "Pick a different target date" },
      { status: 400 }
    );

  // RLS scopes to this org (no manual org filter).
  const { data: visits } = await supabase
    .from("lawn_visits")
    .select("id, jobs(name)")
    .eq("status", "pending")
    .eq("due_date", fromDate);
  const visitRows = (visits as unknown as VisitRow[] | null) ?? [];

  let moved = 0;
  const conflicts: { jobName: string; dueDate: string }[] = [];

  for (const v of visitRows) {
    const { error } = await supabase
      .from("lawn_visits")
      .update({ due_date: toDate })
      .eq("id", v.id);
    if (error) {
      // 23505 = a visit already exists on `toDate` for this schedule. Skip it
      // and surface to the office so they know not every visit moved.
      if (error.code === "23505") {
        conflicts.push({ jobName: v.jobs?.name ?? "—", dueDate: toDate });
      } else {
        // Unexpected — log and skip; do not crash the batch.
        console.error("bulk-move update failed", error.code, error.message);
      }
    } else {
      moved += 1;
    }
  }

  return NextResponse.json({ moved, conflicts });
}