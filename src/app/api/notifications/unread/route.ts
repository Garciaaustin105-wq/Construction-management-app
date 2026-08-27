import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ unread: 0 });
  }
  const user = me.user;

  // super_admin has no org, but same_org() short-circuits true for them — so
  // the jobs/photos/RFIs/notifications counts below would bypass tier_office
  // RLS and aggregate EVERY tenant's activity platform-wide. That's a cross-
  // org leak, not a useful "platform inbox." super_admin is a platform role,
  // not an org workspace user, so the badge is always 0 for them.
  if (me.isSuperAdmin) {
    return NextResponse.json({ unread: 0 });
  }

  const url = new URL(req.url);
  const markSeen = url.searchParams.get("markSeen") === "1";

  // Jobs the user can see (RLS scopes to assigned crew / all for office) and
  // their per-job last-seen stamps. Fetched together: neither depends on the
  // other, and this route is the busiest path in the app, so a serial pair here
  // was a wasted round trip on every call. The markSeen branch below ignores
  // `views`, which costs it one small query it doesn't use — worth it to keep
  // the hot path at one round trip.
  const [{ data: jobs }, { data: views }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, status, created_at, assigned_crew")
      .eq("type", "construction"),
    supabase
      .from("job_views")
      .select("job_id, last_seen_at")
      .eq("user_id", user.id),
  ]);

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

  const lastSeen: Record<string, string> = {};
  for (const v of views ?? []) {
    lastSeen[v.job_id] = v.last_seen_at;
  }

  const epoch = "1970-01-01";
  const jobRows = jobs ?? [];
  const jobIds = jobRows.map((j) => j.id);

  // Each job has its OWN cutoff, which is why this used to be a loop: two
  // `count` queries per job, run serially. At 8 jobs that was 16 sequential
  // round trips on the app's most-requested route.
  //
  // Instead: fetch once from the EARLIEST cutoff across all visible jobs, then
  // bucket per job in JS applying each job's real cutoff. Same numbers, two
  // parallel queries instead of 2N serial ones. Only (job_id, created_at) is
  // selected — the rows are tiny and RLS already bounds them to this user's
  // jobs — and `.in(jobIds)` bounds them again.
  let minSince: string | null = null;
  for (const job of jobRows) {
    const since = lastSeen[job.id] ?? epoch;
    if (minSince === null || since < minSince) minSince = since;
  }

  // The old per-job form used `count: exact, head: true`, which has no row
  // limit. Fetching rows instead means PostgREST's row cap applies, so state it
  // explicitly rather than inherit whatever the platform default happens to be:
  // past this many unseen items the badge saturates instead of silently
  // undercounting by an unknown amount. It is a notification badge — the
  // difference between "1000" and "1,000,000" is not information a user acts
  // on, and no real inbox reaches it.
  const BADGE_ROW_CAP = 1000;
  const emptyRows = { data: [] as { job_id: string; created_at: string }[] };
  const [photoRes, rfiRes, noteRes] = await Promise.all([
    jobIds.length
      ? supabase
          .from("photos")
          .select("job_id, created_at")
          .in("job_id", jobIds)
          .gt("created_at", minSince ?? epoch)
          .limit(BADGE_ROW_CAP)
      : Promise.resolve(emptyRows),
    jobIds.length
      ? supabase
          .from("rfis")
          .select("job_id, created_at")
          .in("job_id", jobIds)
          .gt("created_at", minSince ?? epoch)
          .limit(BADGE_ROW_CAP)
      : Promise.resolve(emptyRows),
    // Office notifications feed (estimate accepted/declined, invoice paid). RLS
    // (tier_office) scopes this to the caller's org + office-like; a crew caller
    // gets count 0, so the badge never includes office-only activity for them.
    supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .is("read_at", null),
  ]);

  // Bucket by job so each job's own cutoff is applied — this is what keeps the
  // result identical to the per-job queries it replaces.
  const perJob = (rows: { job_id: string; created_at: string }[] | null) => {
    const counts = new Map<string, number>();
    for (const r of rows ?? []) {
      const since = lastSeen[r.job_id] ?? epoch;
      if (r.created_at > since) {
        counts.set(r.job_id, (counts.get(r.job_id) ?? 0) + 1);
      }
    }
    return counts;
  };
  const photoByJob = perJob(photoRes.data);
  const rfiByJob = perJob(rfiRes.data);

  let unread = 0;
  for (const job of jobRows) {
    const since = lastSeen[job.id] ?? epoch;
    // A status change after last_seen counts as 1.
    const statusChange = job.created_at > since ? 1 : 0;
    unread +=
      (photoByJob.get(job.id) ?? 0) + (rfiByJob.get(job.id) ?? 0) + statusChange;
  }
  unread += ("count" in noteRes ? noteRes.count : 0) ?? 0;

  return NextResponse.json({ unread });
}