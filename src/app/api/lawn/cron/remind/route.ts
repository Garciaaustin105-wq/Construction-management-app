import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sendCustomerNotification, type NotificationCache } from "@/lib/customerNotifications";
import { buildStaticMapUrl } from "@/lib/staticMap";
import { isLawn } from "@/lib/variant";

// Morning-of customer reminders for today's lawn visits. Fires ~8 AM local
// (vercel.json "8 13 * * *" = 13:08 UTC ≈ 08:00 CDT/07:00 CST). For every visit
// due today that is still `pending`, sends the visit_reminder notification
// (templated, opt-in gated, both email+sms attempted) to the job's customer.
//
// Secured by CRON_SECRET (Vercel Cron sends `Authorization: Bearer <secret>`),
// runs with the service role (bypasses RLS) so it can read across orgs and log
// without a session. Mirrors /api/lawn/cron/generate. Idempotent enough for
// once-daily: a re-run the same day re-sends (acceptable; cron fires once).
// Construction orgs have no seeded templates unless an office enabled them, so
// this is a no-op there — harmless.

export const dynamic = "force-dynamic";
// Vercel default function timeout (10s Hobby) is too short for a platform-wide
// reminder sweep. Bump to the Hobby ceiling (60s). The per-visit work below is
// batched/concurrency-bounded so this is headroom, not the fix — but it stops a
// busy day from silently dropping the orgs that sorted last. Raise to 300 on Pro.
export const maxDuration = 60;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// "09:00:00" -> "9:00 AM". Wall-clock only (the date is due_date), so no tz
// conversion — the window is whatever the office typed for that property.
function fmtTime(t: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(":");
  const hour = Number(h);
  if (!Number.isFinite(hour)) return null;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m} ${suffix}`;
}

// Both ends required — a half-open window can't be phrased as "between X and Y".
function arrivalWindow(start: string | null, end: string | null): string | null {
  const a = fmtTime(start);
  const b = fmtTime(end);
  return a && b ? `${a} - ${b}` : null;
}

type VisitRow = {
  id: string;
  job_id: string;
  organization_id: string;
  due_date: string;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
};

type JobRow = {
  id: string;
  customer_id: string | null;
  name: string | null;
  address: string | null;
  organization_id: string | null;
  lawn_jobs: { map_lat: number | null; map_lng: number | null } | null;
};

// Distinct, order-preserving — builds the .in() lists from visit fields.
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 401 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One shared database, two Vercel deploys: both schedule this cron (same
  // vercel.json). The construction deploy is the established cron owner; the
  // lawn deploy's scheduled invocation no-ops here to avoid double reminder
  // emails (each fire would send its own set). If ownership ever moves to the
  // lawn deploy, flip this gate.
  if (isLawn()) {
    return NextResponse.json({ ok: true, skipped: "construction owns cron" });
  }

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured (service role missing)" },
      { status: 500 }
    );
  }
  const admin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const today = todayISO();

  // Today's still-pending visits, ordered (organization_id, id) for deterministic
  // processing. Ordering is what makes a partial run resumable: a re-trigger
  // after a timeout picks up the not-yet-sent visits instead of re-doing the
  // first orgs and dropping the rest.
  const { data: visits } = await admin
    .from("lawn_visits")
    .select("id, job_id, organization_id, due_date, scheduled_window_start, scheduled_window_end")
    .eq("due_date", today)
    .eq("status", "pending")
    .order("organization_id", { ascending: true })
    .order("id", { ascending: true });
  const visitRows = (visits as unknown as VisitRow[] | null) ?? [];

  // Idempotent resume: a manual re-trigger (or a double-fire if the cron gate
  // ever broke) must NOT double-send. A visit_reminder 'sent' log row for this
  // visit means it was already delivered — skip it. Failures (status='failed')
  // are retried; skips re-evaluate (cheap, idempotent). This is the resume
  // cursor: progress = the set of visits already sent, so a re-run only does the
  // ones that were dropped.
  const allIds = visitRows.map((v) => v.id);
  const sentToday = new Set<string>();
  if (allIds.length > 0) {
    const { data: logRows } = await admin
      .from("notification_log")
      .select("entity_id")
      .eq("event", "visit_reminder")
      .eq("status", "sent")
      .in("entity_id", allIds);
    for (const r of (logRows ?? []) as { entity_id: string }[]) {
      sentToday.add(r.entity_id);
    }
  }
  const pending = visitRows.filter((v) => !sentToday.has(v.id));

  // Hoist the org lookup out of the per-visit loop: one fetch for every distinct
  // org into a name map. The old loop refetched the same org row on every visit
  // in that org.
  const orgIds = unique(pending.map((v) => v.organization_id));
  const orgNameById = new Map<string, string>();
  if (orgIds.length > 0) {
    const { data: orgs } = await admin
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    for (const o of (orgs ?? []) as { id: string; name: string | null }[]) {
      orgNameById.set(o.id, o.name ?? "");
    }
  }

  // Batch the job lookups: one fetch (with the lawn_jobs pin join) for every
  // distinct job into a map. The old loop did one jobs query per visit.
  const jobIds = unique(pending.map((v) => v.job_id));
  const jobById = new Map<string, JobRow>();
  if (jobIds.length > 0) {
    const { data: jobRows } = await admin
      .from("jobs")
      .select("id, customer_id, name, address, organization_id, lawn_jobs(map_lat, map_lng)")
      .in("id", jobIds);
    for (const j of (jobRows ?? []) as unknown as JobRow[]) {
      jobById.set(j.id, j);
    }
  }

  // Per-invocation settings/template cache — settings + templates are org-scoped
  // and identical across an org's visits, so fetch once per org/event×channel.
  // Scoped to this run; never module-level (would leak settings across orgs).
  const cache: NotificationCache = {
    settings: new Map(),
    templates: new Map(),
  };

  let processed = 0;
  let sent = 0;
  const errors: { visit_id: string; error: string }[] = [];

  // Bound the email concurrency: process in chunks so we don't exceed the mail
  // provider's rate limit or fire an unbounded fan-out. Each chunk awaits
  // allSettled before the next — a rejection in one visit never kills the others.
  const CHUNK = 8;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const outcomes = await Promise.allSettled(
      slice.map(async (v) => {
        processed += 1;
        const j = jobById.get(v.job_id);
        const customerId = j?.customer_id ?? null;
        if (!customerId) return; // no customer to notify
        const orgId = v.organization_id || j?.organization_id;
        if (!orgId) return;

        const orgName = orgNameById.get(orgId) ?? null;

        // Property map image for the email (Static Maps). null when the job has no
        // pin or GOOGLE_MAPS_STATIC_KEY is unset → email sends without the image.
        const pin = j?.lawn_jobs;
        const mapImageUrl = buildStaticMapUrl(pin?.map_lat ?? null, pin?.map_lng ?? null);

        // Window copy. Passed BOTH as its own {{arrival_window}} token (for
        // templates that want to place it) AND appended to {{service_date}} — the
        // seeded templates in every existing org only render {{service_date}},
        // so appending is what actually makes "between 9 and 11" show up without
        // a template migration. No window -> service_date is unchanged, which is
        // the current "today" copy.
        const windowText = arrivalWindow(
          v.scheduled_window_start,
          v.scheduled_window_end
        );

        const results = await sendCustomerNotification({
          supabase: admin,
          event: "visit_reminder",
          organizationId: orgId,
          visitId: v.id,
          customerId,
          customerName: null, // resolved inside the helper
          jobName: j?.name ?? null,
          address: j?.address ?? null,
          serviceDate: windowText ? `${v.due_date} between ${windowText}` : v.due_date,
          arrivalWindow: windowText,
          orgName,
          mapImageUrl,
          cache,
        });
        if (results.some((r) => r.status === "sent")) sent += 1;
      })
    );
    slice.forEach((v, idx) => {
      const r = outcomes[idx];
      if (r.status === "rejected") {
        errors.push({
          visit_id: v.id,
          error: r.reason instanceof Error ? r.reason.message : "unknown",
        });
      }
    });
  }

  return NextResponse.json({
    ok: true,
    visits: processed,
    notified: sent,
    errors,
  });
}