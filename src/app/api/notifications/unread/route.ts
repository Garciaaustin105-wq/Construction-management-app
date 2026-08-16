import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ unread: 0 });
  }

  const url = new URL(req.url);
  const markSeen = url.searchParams.get("markSeen") === "1";

  // Get jobs user can see (RLS scopes to assigned crew / all for office).
  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, status, created_at, assigned_crew")
    .eq("type", "construction");

  // markSeen=1: the user just landed on Home, so stamp every visible job as
  // seen NOW (in the same request, before computing) and return 0. This fixes
  // the race where the client badge refetch beat the dashboard's fire-and-
  // forget job_views upsert and read a stale count.
  if (markSeen) {
    const now = new Date().toISOString();
    if (jobs && jobs.length > 0) {
      await supabase.from("job_views").upsert(
        jobs.map((j) => ({
          user_id: user.id,
          job_id: j.id,
          last_seen_at: now,
        })),
        { onConflict: "user_id,job_id" }
      );
    }
    // Clear the office notifications feed (org-scoped shared inbox). RLS
    // (tier_office) scopes this to the caller's org + office-like; a crew
    // caller's update is a 0-row no-op, which is correct — they never see it.
    // Runs even when the caller has no construction jobs so the badge still
    // clears for an office user whose only unread items are notifications.
    await supabase
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null);
    return NextResponse.json({ unread: 0 });
  }

  // Get last seen time per job (default = epoch for jobs never seen)
  const { data: views } = await supabase
    .from("job_views")
    .select("job_id, last_seen_at")
    .eq("user_id", user.id);

  const lastSeen: Record<string, string> = {};
  for (const v of views ?? []) {
    lastSeen[v.job_id] = v.last_seen_at;
  }

  const epoch = "1970-01-01";
  let unread = 0;

  for (const job of jobs ?? []) {
    const since = lastSeen[job.id] ?? epoch;
    // Count photos after last_seen
    const { count: photoCount } = await supabase
      .from("photos")
      .select("*", { count: "exact", head: true })
      .eq("job_id", job.id)
      .gt("created_at", since);
    // Count RFIs after last_seen
    const { count: rfiCount } = await supabase
      .from("rfis")
      .select("*", { count: "exact", head: true })
      .eq("job_id", job.id)
      .gt("created_at", since);
    // If status changed after last_seen, count it as 1
    let statusChange = 0;
    if (job.created_at > since) statusChange = 1;

    unread += (photoCount ?? 0) + (rfiCount ?? 0) + statusChange;
  }

  // Office notifications feed (estimate accepted/declined, invoice paid). RLS
  // (tier_office) scopes this to the caller's org + office-like; a crew caller
  // gets count 0, so the badge never includes office-only activity for them.
  const { count: noteCount } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .is("read_at", null);
  unread += noteCount ?? 0;

  return NextResponse.json({ unread });
}