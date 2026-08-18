import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM, type Role } from "@/lib/roles";

// Mark a job as "seen" by the caller. The caller must be allowed to view that
// job — office, an assigned crew member, or the owning customer — before we
// write a view record. Otherwise a crew member who isn't on a job could still
// suppress its notifications by stamping a fake view.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Caller's role + customer link
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, customer_id")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  const customerId = profile?.customer_id ?? null;

  // Office-like (office/admin/super_admin) and PM oversee every job in their
  // org (RLS admits them via tier_office_or_pm), so they can mark any org job
  // seen without a per-job access-scope check. Everyone else (crew/customer)
  // must be assigned to / own the job.
  if (!OFFICE_OR_PM.has(role as Role)) {
    // Fetch the job's access scope (RLS already hides jobs the caller can't
    // see; a null job means not-found OR not-authorized — treat both as 403).
    const { data: job } = await supabase
      .from("jobs")
      .select("assigned_crew, customer_id")
      .eq("id", jobId)
      .single();

    const assigned = (job?.assigned_crew ?? []) as string[];
    const allowed =
      !!job &&
      (role === "crew"
        ? assigned.includes(user.id)
        : role === "customer"
          ? !!customerId && job.customer_id === customerId
          : false);

    if (!allowed) {
      return NextResponse.json({ error: "Not authorized for this job" }, { status: 403 });
    }
  }

  const { error } = await supabase.from("job_views").upsert(
    { user_id: user.id, job_id: jobId, last_seen_at: new Date().toISOString() },
    { onConflict: "user_id,job_id" }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}