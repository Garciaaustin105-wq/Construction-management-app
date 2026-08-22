// In-app calendar event sources for the /calendar page (month grid + agenda).
//
// Mirrors the iCal feed's event sources (src/app/api/calendar/feed/route.ts) but
// queries with the **RLS session client** instead of the service-role admin
// client. That means RLS already scopes every read to the caller's org AND
// enforces role visibility (office→all, crew→assigned jobs, customer→own;
// crew/customer get an empty set for invoices + job_subcontractors where they
// have no SELECT policy). So this layer does NOT replicate the feed's manual
// `orgFilter`/role branching — it just queries each table and normalizes.
//
// Variant gating mirrors the feed, tightened so construction-only sources
// don't even run in the lawn variant: jobs (filtered to type=construction),
// schedule_events, invoices, estimates run unconditionally (jobs + their
// job-anchored event rows are empty for lawn orgs via the DB trigger; invoices
// + estimates are shared). job_subcontractors is construction-only and is
// skipped entirely when isLawn() (no lawn UI creates those rows). The
// lawn_visits block runs only when isLawn().
//
// Only org-scoped users should call this (the /calendar page short-circuits
// super_admin-without-org to a notice). super_admin WITH an org is scoped by
// RLS same_org to that org.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isLawn } from "@/lib/variant";

export type CalEventType =
  | "job-start"
  | "job-end"
  | "event"
  | "sub"
  | "invoice"
  | "estimate"
  | "lawn"
  | "install";

export type CalEvent = {
  id: string;
  // YYYY-MM-DD the chip sits on (all-day for every type except schedule_events,
  // which also carry `time`).
  date: string;
  title: string;
  type: CalEventType;
  // HH:mm (local) for timed schedule_events; omitted for all-day events.
  time?: string;
  // Best-effort link to the owning detail page (no new routes).
  href?: string;
};

// Row shapes for the relation selects. Supabase's generated types type joins
// loosely, so the returned rows are cast via `as unknown as Row[]` (same pattern
// as the feed route + src/lib/reports.ts). Many-to-one FKs surface as a single
// object (or null) at runtime.
type JobRow = {
  id: string;
  name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customers: { name: string } | null;
};
type EventRow = {
  id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  kind: string;
  job_id: string;
  jobs: { name: string } | null;
};
type SubRow = {
  id: string;
  scheduled_date: string | null;
  role_on_job: string | null;
  job_id: string;
  subcontractor: { company: string } | null;
  jobs: { name: string } | null;
};
type InvoiceRow = {
  id: string;
  due_date: string | null;
  jobs: { name: string } | null;
  customers?: { name: string } | null;
};
type EstimateRow = {
  id: string;
  valid_until: string | null;
  jobs: { name: string } | null;
  customers?: { name: string } | null;
};
// Installs (ISP/fiber module). Present only for orgs with
// organizations.isp_module_enabled; every other org gets zero rows from RLS,
// and if the isp_module.sql migration hasn't been run yet the query errors and
// `.data` is null — both cases fall through to an empty list rather than
// breaking the calendar, same defensive shape as the other sources here.
type InstallRow = {
  id: string;
  title: string;
  scheduled_at: string | null;
  status: string;
  install_types: { name: string } | null;
  customers: { name: string } | null;
};
type VisitRow = {
  id: string;
  due_date: string;
  status: string;
  job_id: string;
  recurring_schedules: { service_type: string | null } | null;
  jobs: { name: string } | null;
};

// Date columns come back as YYYY-MM-DD strings already; timestamptz needs
// slicing. Keep helpers local so this module has no external date dep (the app
// hand-rolls dates — no date-fns/dayjs; see src/lib/weekUtils.ts).
function dateOf(isoOrDate: string): string {
  // Works for both `YYYY-MM-DD` (date column) and `YYYY-MM-DDTHH:mm:ss…` (timestamptz).
  return isoOrDate.slice(0, 10);
}
function timeOf(timestamptz: string): string | undefined {
  // Local HH:mm from a timestamptz. slice(11,16) gives UTC HH:mm which is fine
  // for a display hint; the feed does the same (no tz conversion).
  const t = timestamptz.slice(11, 16);
  return t || undefined;
}

export async function getCalendarEvents(
  supabase: SupabaseClient
): Promise<CalEvent[]> {
  const events: CalEvent[] = [];

  // Fire all independent source queries in parallel.
  const [
    jobsRes,
    eventsRes,
    subsRes,
    invoicesRes,
    estimatesRes,
    visitsRes,
    installsRes,
  ] = await Promise.all([
      // Jobs (construction-typed start/end). Lawn orgs have none (DB trigger),
      // so this is empty in the lawn variant — no isLawn gate needed.
      supabase
        .from("jobs")
        .select("id, name, scheduled_start, scheduled_end, customers(name)")
        .eq("type", "construction"),

      // Schedule events (timed). RLS scopes to this org + role.
      supabase
        .from("schedule_events")
        .select("id, title, start_at, end_at, kind, job_id, jobs(name)")
        .order("start_at", { ascending: true })
        .limit(500),

      // Subcontractor on-site dates (office/PM only — RLS denies crew/customer,
      // returning an empty set). Construction variant only — lawn orgs have no
      // subcontractors (no UI to create them; construction jobs are trigger-
      // blocked), so skip the query entirely rather than rely on data-absence.
      !isLawn()
        ? supabase
            .from("job_subcontractors")
            .select(
              "id, scheduled_date, role_on_job, job_id, subcontractor:subcontractors(company), jobs(name)"
            )
            .not("scheduled_date", "is", null)
        : Promise.resolve({ data: null, error: null }),

      // Invoice due dates (office/PM all; customer own; crew none — RLS).
      supabase
        .from("invoices")
        .select("id, due_date, jobs(name), customers(name)")
        .not("due_date", "is", null)
        .limit(500),

      // Estimate expiry (office/PM all; customer own sent+; crew assigned — RLS).
      supabase
        .from("estimates")
        .select("id, valid_until, jobs(name), customers(name)")
        .not("valid_until", "is", null)
        .limit(500),

      // Lawn visits — LAWN VARIANT ONLY (mirrors the feed's isLawn() gate).
      isLawn()
        ? supabase
            .from("lawn_visits")
            .select(
              "id, due_date, status, job_id, recurring_schedules(service_type), jobs(name)"
            )
            .in("status", ["pending", "done"])
            .order("due_date", { ascending: true })
            .limit(500)
        : Promise.resolve({ data: null, error: null }),

      // Installs (ISP/fiber module) — timed, and crew-visible through the
      // installs table's OWN RLS (assigned_crew on the row), which is exactly
      // why installs don't ride on schedule_events: that table resolves crew
      // visibility through job_id, and an install may have no job.
      supabase
        .from("installs")
        .select(
          "id, title, scheduled_at, status, install_types(name), customers(name)"
        )
        .not("scheduled_at", "is", null)
        .neq("status", "cancelled")
        .order("scheduled_at", { ascending: true })
        .limit(500),
    ]);

  // ── Jobs (start + end) ────────────────────────────────────────────────────
  for (const j of (jobsRes.data ?? []) as unknown as JobRow[]) {
    const jobName = j.name ?? "Job";
    const cust = j.customers?.name;
    const ctx = cust ? ` · ${cust}` : "";
    if (j.scheduled_start) {
      events.push({
        id: `js-${j.id}`,
        date: dateOf(j.scheduled_start),
        title: `${jobName} — Job start${ctx}`,
        type: "job-start",
        href: `/jobs/${j.id}`,
      });
    }
    if (j.scheduled_end) {
      events.push({
        id: `je-${j.id}`,
        date: dateOf(j.scheduled_end),
        title: `${jobName} — Job end${ctx}`,
        type: "job-end",
        href: `/jobs/${j.id}`,
      });
    }
  }

  // ── Schedule events (timed) ────────────────────────────────────────────────
  for (const e of (eventsRes.data ?? []) as unknown as EventRow[]) {
    const jobName = e.jobs?.name;
    events.push({
      id: `ev-${e.id}`,
      date: dateOf(e.start_at),
      title: jobName ? `${e.title} · ${jobName}` : e.title,
      type: "event",
      time: timeOf(e.start_at),
      href: `/jobs/${e.job_id}`,
    });
  }

  // ── Subcontractor on-site dates ────────────────────────────────────────────
  for (const s of (subsRes.data ?? []) as unknown as SubRow[]) {
    if (!s.scheduled_date) continue;
    const company = s.subcontractor?.company ?? "Subcontractor";
    const jobName = s.jobs?.name;
    events.push({
      id: `sub-${s.id}`,
      date: dateOf(s.scheduled_date),
      title: `${company} on site${jobName ? ` · ${jobName}` : ""}`,
      type: "sub",
      href: `/jobs/${s.job_id}`,
    });
  }

  // ── Invoice due dates ──────────────────────────────────────────────────────
  for (const inv of (invoicesRes.data ?? []) as unknown as InvoiceRow[]) {
    if (!inv.due_date) continue;
    const cust = inv.customers?.name;
    events.push({
      id: `inv-${inv.id}`,
      date: dateOf(inv.due_date),
      title: `Invoice due${cust ? ` · ${cust}` : ""}`,
      type: "invoice",
      href: `/invoices`,
    });
  }

  // ── Estimate expiry ────────────────────────────────────────────────────────
  for (const est of (estimatesRes.data ?? []) as unknown as EstimateRow[]) {
    if (!est.valid_until) continue;
    const cust = est.customers?.name;
    events.push({
      id: `est-${est.id}`,
      date: dateOf(est.valid_until),
      title: `Estimate expires${cust ? ` · ${cust}` : ""}`,
      type: "estimate",
      href: `/estimates`,
    });
  }

  // ── Lawn visits (lawn variant only) ────────────────────────────────────────
  for (const v of (visitsRes.data ?? []) as unknown as VisitRow[]) {
    const svc = v.recurring_schedules?.service_type;
    const jobName = v.jobs?.name;
    events.push({
      id: `lawn-${v.id}`,
      date: dateOf(v.due_date),
      title: `${svc ?? "Lawn visit"}${jobName ? ` · ${jobName}` : ""}`,
      type: "lawn",
      href: `/lawn/visits/${v.id}`,
    });
  }

  // ── Installs (ISP/fiber module) ────────────────────────────────────────────
  for (const ins of (installsRes.data ?? []) as unknown as InstallRow[]) {
    if (!ins.scheduled_at) continue;
    const kind = ins.install_types?.name;
    const cust = ins.customers?.name;
    events.push({
      id: `install-${ins.id}`,
      date: dateOf(ins.scheduled_at),
      title: `${kind ? `${kind} — ` : ""}${ins.title}${cust ? ` · ${cust}` : ""}`,
      type: "install",
      time: timeOf(ins.scheduled_at),
      href: `/installs/${ins.id}`,
    });
  }

  return events;
}