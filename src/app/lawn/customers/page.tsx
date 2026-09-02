import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isLawn } from "@/lib/variant";
import { FIELD, MANAGEMENT } from "@/lib/roles";
import PageContainer from "@/components/PageContainer";
import PropertyHub, {
  type HubCustomer,
  type HubVisit,
} from "@/components/PropertyHub";
import { todayInZone } from "@/lib/orgDate";

// The property hub — one page for a customer's whole history: visits, photos,
// schedules, contact details. Historically this lived in four places
// (/lawn/jobs, /lawn/completed, /lawn/photos, the calendar), and finding "when
// did we last cut this yard" meant four page loads, each throwing away your
// place. Here the server component fetches EVERYTHING once and hands it to the
// client component as props; selecting a customer, opening a visit, and
// switching tabs never navigate and never hit the network.
//
// There is no /lawn/customers directory to conflict with: /admin/customers is
// the customer CRM (edit surface), this is the read-only history surface that
// sits in front of it. The hub links out to the CRM for editing — that is the
// one route it takes off this page.
//
// RLS scopes every query to the caller's org; there are no manual
// organization_id filters here. Field roles (crew included) reach this on
// purpose: looking up a property is a field question too.

export const dynamic = "force-dynamic";

export default async function LawnCustomersPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!isLawn()) redirect("/dashboard");

  const role = me.role;
  if (!(FIELD.has(role as never) || MANAGEMENT.has(role as never))) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  // "Today" where the BUSINESS is, not where the Vercel server is (UTC). The
  // toISOString() day shifted every evening from 20:00 Eastern — see
  // src/lib/orgDate.ts. Resolved once here and threaded through as a string.
  let timeZone: string | null = null;
  if (me.orgId) {
    const { data: orgTzRow } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", me.orgId)
      .maybeSingle();
    timeZone = (orgTzRow as { timezone: string | null } | null)?.timezone ?? null;
  }
  const today = todayInZone(timeZone);

  // Customers + lawn properties are independent reads — fan them out. The
  // customer link comes from jobs.customer_id (a real column), NOT from a
  // customers embed: this repo has been bitten by embed-based joins on this
  // exact path (PGRST108 on un-declared FKs, and !inner silently dropping
  // jobs with no customer). Grouping on the column itself keeps every property
  // reachable, customer or not.
  const [custRes, jobsRes] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, name, contact_name, contact_email, phone, address, notes"
      )
      .order("name"),
    supabase
      .from("jobs")
      .select("id, name, address, customer_id")
      .eq("type", "lawn") // the construction org owns a lawn job; RLS alone will not keep the two apps apart
      .order("name"),
  ]);

  type CRow = {
    id: string;
    name: string | null;
    contact_name: string | null;
    contact_email: string | null;
    phone: string | null;
    address: string | null;
    notes: string | null;
  };
  type JRow = {
    id: string;
    name: string | null;
    address: string | null;
    customer_id: string | null;
  };
  const custRows = (custRes.data ?? []) as unknown as CRow[];
  const jobRows = (jobsRes.data ?? []) as unknown as JRow[];
  const custById = new Map(custRows.map((c) => [c.id, c] as const));
  const jobIds = jobRows.map((j) => j.id);

  // Visits + schedules fan out together once the job ids exist.
  const [visitRes, schedRes] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select(
        "id, job_id, recurring_schedule_id, due_date, status, completed_at, started_at, on_site_first_at, on_site_last_at, on_site_user_ids, notes, recurring_schedules(service_type)"
      )
      .in("job_id", jobIds.length ? jobIds : ["00000000-0000-0000-0000-000000000000"])
      .order("due_date", { ascending: false })
      .limit(1000),
    supabase
      .from("recurring_schedules")
      .select(
        "id, job_id, active, service_type, frequency, interval_weeks, price_per_visit"
      )
      .in("job_id", jobIds.length ? jobIds : ["00000000-0000-0000-0000-000000000000"]),
  ]);

  type VRow = {
    id: string;
    job_id: string;
    recurring_schedule_id: string | null;
    due_date: string;
    status: string;
    completed_at: string | null;
    started_at: string | null;
    on_site_first_at: string | null;
    on_site_last_at: string | null;
    on_site_user_ids: string[] | null;
    notes: string | null;
    recurring_schedules: { service_type: string | null } | null;
  };
  type SRow = {
    id: string;
    job_id: string;
    active: boolean;
    service_type: string | null;
    frequency: string | null;
    interval_weeks: number | null;
    price_per_visit: number | string | null;
  };
  const visitRows = (visitRes.data ?? []) as unknown as VRow[];
  const schedRows = (schedRes.data ?? []) as unknown as SRow[];

  // Photos in ONE query keyed by visit, then grouped in JS — the same trick as
  // /lawn/completed. Per-visit round trips would be hundreds of requests.
  const visitIds = visitRows.map((v) => v.id);
  const { data: photoRows } = visitIds.length
    ? await supabase
        .from("photos")
        .select("id, visit_id, storage_path, caption, created_at, phase")
        .in("visit_id", visitIds)
        .order("created_at", { ascending: true })
    : { data: [] };
  type PRow = {
    id: string;
    visit_id: string;
    storage_path: string;
    caption: string | null;
    created_at: string;
    phase: "before" | "after" | null;
  };
  const byVisitId = new Map<string, PRow[]>();
  for (const p of photoRows ?? []) {
    const arr = byVisitId.get(p.visit_id) ?? [];
    arr.push(p);
    byVisitId.set(p.visit_id, arr);
  }

  // ── group ─────────────────────────────────────────────────────────────────
  // Two grouping modes:
  //  • Management (customers table readable — RLS grants tier_management/
  //    tier_office): group by the job's customer_id column, resolved against
  //    the customer rows. A job with NO resolving customer row (id null, or
  //    an id that no longer resolves) lands in the "No customer assigned"
  //    bucket — reachable, labelled, at the bottom of the rail. Never dropped.
  //  • Crew (and any org with zero customer rows): the customers table is
  //    RLS-closed to us (is_management excludes crew), so "group by customer"
  //    would collapse every property into that no-customer bucket and lie.
  //    Instead one group per JOB, named by the property — the rail becomes a
  //    property list and every tab still works on RLS-visible rows only.
  const NO_KEY = "__no_customer__";
  const keyByJob = new Map<string, string>();
  const groups = new Map<string, HubCustomer>();

  if (custRows.length === 0) {
    for (const j of jobRows) {
      const key = `job:${j.id}`;
      keyByJob.set(j.id, key);
      groups.set(key, {
        id: null,
        name: j.name ?? "Untitled property",
        contactName: null,
        contactEmail: null,
        phone: null,
        address: null,
        notes: null,
        properties: [{ id: j.id, name: j.name ?? "Untitled property", address: j.address }],
        visits: [],
        schedules: [],
      });
    }
  } else {
    // Every customer the org has appears in the rail, even with no properties.
    for (const c of custRows) {
      groups.set(c.id, {
        id: c.id,
        name: c.name ?? "Unnamed customer",
        contactName: c.contact_name,
        contactEmail: c.contact_email,
        phone: c.phone,
        address: c.address,
        notes: c.notes,
        properties: [],
        visits: [],
        schedules: [],
      });
    }
    for (const j of jobRows) {
      const key =
        j.customer_id && custById.has(j.customer_id) ? j.customer_id : NO_KEY;
      keyByJob.set(j.id, key);
      const g =
        groups.get(key) ??
        (() => {
          // RLS can leave a referenced customer row invisible to this caller;
          // the bucket still gets a group so its properties stay reachable.
          const fresh: HubCustomer = {
            id: null,
            placeholder: true,
            name: "No customer assigned",
            contactName: null,
            contactEmail: null,
            phone: null,
            address: null,
            notes: null,
            properties: [],
            visits: [],
            schedules: [],
          };
          groups.set(key, fresh);
          return fresh;
        })();
      g.properties.push({ id: j.id, name: j.name ?? "Untitled property", address: j.address });
    }
  }

  const groupOf = (jobId: string): HubCustomer | null => {
    const key = keyByJob.get(jobId);
    return key ? groups.get(key) ?? null : null;
  };

  const jobById = new Map(jobRows.map((j) => [j.id, j] as const));
  for (const r of visitRows) {
    const job = jobById.get(r.job_id);
    if (!job) continue;
    const g = groupOf(r.job_id);
    if (!g) continue;
    // Prefer the MEASURED window over start→done — the geofence records it
    // without anyone tapping anything, and the label must say which number
    // this is (they are different claims; see CompletedVisitsList).
    const measuredMs =
      r.on_site_first_at && r.on_site_last_at
        ? new Date(r.on_site_last_at).getTime() - new Date(r.on_site_first_at).getTime()
        : null;
    const tappedMs =
      r.started_at && r.completed_at
        ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
        : null;
    const photos = (byVisitId.get(r.id) ?? []).map((p) => ({
      id: p.id,
      visitId: p.visit_id,
      storage_path: p.storage_path,
      caption: p.caption,
      created_at: p.created_at,
      phase: p.phase,
    }));
    const visit: HubVisit = {
      id: r.id,
      jobId: r.job_id,
      jobName: job.name ?? "Untitled property",
      address: job.address,
      dueDate: r.due_date,
      status: r.status,
      completedAt: r.completed_at,
      serviceType: r.recurring_schedules?.service_type ?? null,
      notes: r.notes,
      minutes:
        measuredMs !== null
          ? Math.round(measuredMs / 60000)
          : tappedMs !== null
            ? Math.round(tappedMs / 60000)
            : null,
      minutesSource:
        measuredMs !== null ? "measured" : tappedMs !== null ? "tapped" : null,
      onSiteCount: r.on_site_user_ids?.length ?? 0,
      photos,
    };
    g.visits.push(visit);
  }

  // Schedule last/next are derived from the visits already fetched — matched
  // by the visit's recurring_schedule_id, which is exactly the pairing the
  // generator created them from. No new column, no extra query.
  const lastBySchedule = new Map<string, string>();
  const nextBySchedule = new Map<string, string>();
  for (const r of visitRows) {
    const sid = r.recurring_schedule_id;
    if (!sid) continue;
    if (r.status === "done") {
      const prev = lastBySchedule.get(sid);
      if (!prev || r.due_date > prev) lastBySchedule.set(sid, r.due_date);
    } else if (r.status === "pending") {
      const prev = nextBySchedule.get(sid);
      if (!prev || r.due_date < prev) nextBySchedule.set(sid, r.due_date);
    }
  }
  for (const s of schedRows) {
    const job = jobById.get(s.job_id);
    if (!job) continue;
    const g = groupOf(s.job_id);
    if (!g) continue;
    g.schedules.push({
      id: s.id,
      jobId: s.job_id,
      jobName: job.name ?? "Untitled property",
      serviceType: s.service_type,
      frequency: s.frequency,
      intervalWeeks: s.interval_weeks,
      active: s.active,
      pricePerVisit:
        s.price_per_visit === null || s.price_per_visit === ""
          ? null
          : Number(s.price_per_visit),
      lastCompletedDate: lastBySchedule.get(s.id) ?? null,
      nextDueDate: nextBySchedule.get(s.id) ?? null,
    });
  }

  const customers = Array.from(groups.values());

  return (
    <PageContainer
      title="Property Hub"
      subtitle="Every customer's visits, photos, schedules and details — on one page"
      maxWidth="full"
      mainClassName="space-y-4"
    >
      <PropertyHub customers={customers} today={today} />
    </PageContainer>
  );
}