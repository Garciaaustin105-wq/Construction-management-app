import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { buildCalendar, feedUid, type FeedEvent } from "@/lib/ical";

export const dynamic = "force-dynamic";

// PUBLIC iCal subscribe feed — the one surface authenticated by a per-user
// token in the query string (calendar clients can't send headers or cookies).
// The token resolves the user → org + role; the feed then emits VEVENTs for
// every event source that role is authorized to see, scoped to their org, using
// the service role (bypassing RLS) with org + role visibility enforced in-app —
// the same defense-in-depth pattern as /api/receipts/share.
//
// Role-based content (respects the standing security constraint: crew/customer
// get NO subcontractor or financial/customer info beyond their own):
//   office / admin / superintendent / PM  → all org jobs, schedule_events,
//                                            sub dates, invoice due, quote expiry
//   crew                                  → assigned jobs + their schedule_events
//   customer                              → own jobs + their schedule_events +
//                                            own invoice due + own quote expiry
//   super_admin                           → platform-wide (all orgs), all sources

const MANAGEMENT_ROLES = new Set([
  "office",
  "admin",
  "superintendent",
  "project_manager",
]);

function requestHost(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  if (xfhost) return xfhost;
  const hostHeader = request.headers.get("host");
  if (hostHeader) return hostHeader;
  try {
    return new URL(request.url).host;
  } catch {
    return "localhost";
  }
}

// Parse a `date` column ('YYYY-MM-DD') into a UTC-midnight Date for all-day
// events. ical-generator emits DTSTART;VALUE=DATE from an allDay Date.
function allDayDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve the feed row by token. A missing/revoked token → 404 so stale
  // subscribe URLs in a provider surface as "not found", not an empty calendar.
  const { data: feed } = await admin
    .from("calendar_feeds")
    .select("user_id, organization_id")
    .eq("token", token)
    .maybeSingle();

  if (!feed) {
    return new Response("Feed not found", { status: 404 });
  }

  const userId = feed.user_id as string;
  const feedOrgId = feed.organization_id as string;

  // Resolve the user's role (the feed is personal — it reflects what THIS user
  // may see, not what the org broadly contains).
  const { data: profile } = await admin
    .from("profiles")
    .select("role, customer_id")
    .eq("id", userId)
    .single();
  const role = profile?.role ?? "crew";
  const customerId = (profile?.customer_id as string | null) ?? null;

  // super_admin sees platform-wide (no org filter); everyone else is scoped to
  // their feed's org.
  const isSuperAdmin = role === "super_admin";
  const orgFilter = (q: any) => (isSuperAdmin ? q : q.eq("organization_id", feedOrgId));

  // Fire-and-forget: stamp last_fetched_at so the /calendar UI can show "last
  // polled". Not awaited so it never blocks the response.
  void admin
    .from("calendar_feeds")
    .update({ last_fetched_at: new Date().toISOString() })
    .eq("token", token);

  const host = requestHost(request);
  const events: FeedEvent[] = [];

  // ── Jobs (start / end dates) ──────────────────────────────────────────────
  // management + super_admin → all org jobs; crew → assigned; customer → own.
  let jobsQuery = admin
    .from("jobs")
    .select("id, name, scheduled_start, scheduled_end, customers(name)");

  if (MANAGEMENT_ROLES.has(role) || isSuperAdmin) {
    jobsQuery = orgFilter(jobsQuery);
  } else if (role === "crew") {
    // assigned_crew is uuid[] — contains this user's id.
    jobsQuery = jobsQuery.contains("assigned_crew", [userId]);
  } else if (role === "customer") {
    jobsQuery = customerId
      ? jobsQuery.eq("customer_id", customerId)
      : jobsQuery.eq("customer_id", "00000000-0000-0000-0000-000000000000");
  } else {
    jobsQuery = jobsQuery.eq("id", "00000000-0000-0000-0000-000000000000");
  }

  const { data: jobs } = await jobsQuery;
  for (const job of jobs ?? []) {
    const jobName = (job as any).name ?? "Job";
    const custName = ((job as any).customers as { name: string } | null)?.name;
    const ctx = custName ? ` · ${custName}` : "";
    if (job.scheduled_start) {
      events.push({
        uid: feedUid("job-start", job.id, host),
        summary: `${jobName} — Job start${ctx}`,
        start: allDayDate(job.scheduled_start),
        allDay: true,
        description: `Scheduled start date for ${jobName}.`,
      });
    }
    if (job.scheduled_end) {
      events.push({
        uid: feedUid("job-end", job.id, host),
        summary: `${jobName} — Job end${ctx}`,
        start: allDayDate(job.scheduled_end),
        allDay: true,
        description: `Scheduled completion date for ${jobName}.`,
      });
    }
  }

  // The set of job ids this user may see schedule_events for. For management /
  // super_admin it's all org jobs (null → no .in filter); for crew/customer
  // it's the jobs above.
  let visibleJobIds: string[] | null = null;
  if (MANAGEMENT_ROLES.has(role) || isSuperAdmin) {
    visibleJobIds = null;
  } else {
    visibleJobIds = (jobs ?? []).map((j) => j.id);
  }

  // ── Schedule events (timed) ───────────────────────────────────────────────
  let eventsQuery = admin
    .from("schedule_events")
    .select("id, title, start_at, end_at, kind, notes, jobs(name)");

  if (visibleJobIds === null) {
    eventsQuery = orgFilter(eventsQuery);
  } else {
    eventsQuery = eventsQuery.in(
      "job_id",
      visibleJobIds.length ? visibleJobIds : ["00000000-0000-0000-0000-000000000000"]
    );
  }
  eventsQuery = eventsQuery.order("start_at", { ascending: true }).limit(500);

  const { data: schedEvents } = await eventsQuery;
  for (const ev of schedEvents ?? []) {
    const jobName = ((ev as any).jobs as { name: string } | null)?.name;
    events.push({
      uid: feedUid("event", ev.id, host),
      summary: jobName ? `${ev.title} · ${jobName}` : ev.title,
      start: new Date(ev.start_at),
      end: ev.end_at ? new Date(ev.end_at) : undefined,
      allDay: false,
      description:
        [ev.kind, ev.notes].filter(Boolean).join(" — ") || undefined,
    });
  }

  // ── Subcontractor scheduled dates (management / super_admin only) ─────────
  // crew + customer get NO subcontractor information per the security constraint.
  if (MANAGEMENT_ROLES.has(role) || isSuperAdmin) {
    let subQ = admin
      .from("job_subcontractors")
      .select(
        "id, scheduled_date, role_on_job, subcontractor:subcontractors(company), jobs(name)"
      )
      .not("scheduled_date", "is", null);
    subQ = orgFilter(subQ);
    const { data: subs } = await subQ;
    for (const s of subs ?? []) {
      const company = ((s as any).subcontractor as { company: string } | null)?.company ?? "Subcontractor";
      const jobName = ((s as any).jobs as { name: string } | null)?.name;
      events.push({
        uid: feedUid("sub", s.id, host),
        summary: `${company} on site${jobName ? ` · ${jobName}` : ""}`,
        start: allDayDate(s.scheduled_date),
        allDay: true,
        description: s.role_on_job
          ? `${company} scheduled — ${s.role_on_job}`
          : `${company} scheduled on site.`,
      });
    }
  }

  // ── Invoice due dates ─────────────────────────────────────────────────────
  // management / super_admin → all org; customer → own invoices; crew → none.
  if (MANAGEMENT_ROLES.has(role) || isSuperAdmin) {
    let invQ = admin
      .from("invoices")
      .select("id, due_date, jobs(name), customers(name)")
      .not("due_date", "is", null);
    invQ = orgFilter(invQ);
    const { data: invs } = await invQ;
    for (const inv of invs ?? []) {
      const jobName = ((inv as any).jobs as { name: string } | null)?.name;
      const custName = ((inv as any).customers as { name: string } | null)?.name;
      events.push({
        uid: feedUid("inv", inv.id, host),
        summary: `Invoice due${custName ? ` · ${custName}` : ""}`,
        start: allDayDate(inv.due_date),
        allDay: true,
        description: jobName
          ? `Payment due for invoice on ${jobName}.`
          : "Payment due.",
      });
    }
  } else if (role === "customer" && customerId) {
    const { data: invs } = await admin
      .from("invoices")
      .select("id, due_date, jobs(name)")
      .eq("customer_id", customerId)
      .not("due_date", "is", null);
    for (const inv of invs ?? []) {
      const jobName = ((inv as any).jobs as { name: string } | null)?.name;
      events.push({
        uid: feedUid("inv", inv.id, host),
        summary: "Invoice due",
        start: allDayDate(inv.due_date),
        allDay: true,
        description: jobName
          ? `Payment due for ${jobName}.`
          : "Payment due.",
      });
    }
  }

  // ── Quote expiry dates ────────────────────────────────────────────────────
  // management / super_admin → all org; customer → own quotes; crew → none.
  if (MANAGEMENT_ROLES.has(role) || isSuperAdmin) {
    let quoteQ = admin
      .from("quotes")
      .select("id, valid_until, jobs(name), customers(name)")
      .not("valid_until", "is", null);
    quoteQ = orgFilter(quoteQ);
    const { data: quotes } = await quoteQ;
    for (const q of quotes ?? []) {
      const jobName = ((q as any).jobs as { name: string } | null)?.name;
      const custName = ((q as any).customers as { name: string } | null)?.name;
      events.push({
        uid: feedUid("quote", q.id, host),
        summary: `Quote expires${custName ? ` · ${custName}` : ""}`,
        start: allDayDate(q.valid_until),
        allDay: true,
        description: jobName
          ? `Quote for ${jobName} expires today.`
          : "Quote expires today.",
      });
    }
  } else if (role === "customer" && customerId) {
    const { data: quotes } = await admin
      .from("quotes")
      .select("id, valid_until, jobs(name)")
      .eq("customer_id", customerId)
      .not("valid_until", "is", null);
    for (const q of quotes ?? []) {
      const jobName = ((q as any).jobs as { name: string } | null)?.name;
      events.push({
        uid: feedUid("quote", q.id, host),
        summary: "Quote expires",
        start: allDayDate(q.valid_until),
        allDay: true,
        description: jobName
          ? `Quote for ${jobName} expires today.`
          : "Quote expires today.",
      });
    }
  }

  const ics = buildCalendar(events, host);
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="terra-vista.ics"',
      // Providers poll on their own schedule; let caches hold the feed for an
      // hour so a re-poll mid-refresh isn't a full DB round-trip.
      "Cache-Control": "public, max-age=3600",
    },
  });
}