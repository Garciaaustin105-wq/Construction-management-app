import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState from "@/components/EmptyState";
import Card, { CardHeader } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import KpiTile from "@/components/charts/KpiTile";
import { FIELD_MGMT, OFFICE_OR_PM, isOfficeLike } from "@/lib/roles";
import { summarizeSchedule } from "@/lib/lawnRecurrence";
import NotificationsFeed from "@/components/NotificationsFeed";
import RoleOnboarding from "@/components/RoleOnboarding";
import FieldReadinessBanner from "@/components/FieldReadinessBanner";
import { getMe } from "@/lib/tenant";
import Link from "next/link";
import {
  Plus,
  Sprout,
  CalendarDays,
  Calendar,
  Route,
  Scissors,
  CloudSun,
  FileText,
  Users,
  Contact,
  TrendingUp,
  Snowflake,
  Bell,
  Ruler,
} from "lucide-react";

// Row shapes for the relation joins (Supabase types these loosely, so we cast
// via `as unknown as Row[]` — same pattern as estimates/page.tsx).
type VisitRow = {
  id: string;
  due_date: string;
  status: string;
  // customers is reached THROUGH jobs (lawn_visits has job_id, no customer_id),
  // so the embed is jobs(..., customers(name)) — a direct customers(name) here
  // would 400 (PGRST118, no FK) and null out the whole query.
  jobs: {
    name: string;
    address: string | null;
    customers: { name: string | null } | null;
  } | null;
};
type ScheduleRow = {
  id: string;
  frequency: string;
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  service_type: string | null;
  price_per_visit: number;
  active: boolean;
  jobs: { name: string; customers: { name: string | null } | null } | null;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-gray-100 text-gray-500",
  paused: "bg-blue-100 text-blue-700",
};

function dueLabel(dueDate: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return "Overdue";
  if (dueDate === today) return "Today";
  return new Date(`${dueDate}T00:00:00.000Z`).toLocaleDateString();
}

// Overline for a Quick Actions group — matches /dashboard's sidebar.
const GROUP_LABEL =
  "text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-3 first:mt-0";

export default async function LawnPage() {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + a separate profiles round-trip for the role.
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  // super_admin is a PLATFORM role with a null org; same_org() short-circuits
  // true for it, so every query on this page (lawn_visits, recurring_schedules,
  // notifications — all org-scoped) would aggregate EVERY tenant's data. That
  // is a cross-org leak. super_admin also has platform-only nav
  // (Home/Users/Platform/Dev) with no lawn workspace, so it has no business on
  // /lawn. Send it to /dashboard (its platform home on both variants, where
  // the lawn redirect is already exempted for super_admin). Same treatment as
  // /dashboard gating the notifications feed OFF for super_admin.
  if (role === "super_admin") redirect("/dashboard");
  // /lawn is the office dispatch landing. Admit field/office MANAGEMENT
  // (FIELD_MGMT: office / admin / project_manager / superintendent —
  // super_admin handled above) — dispatchers + PM running routes. Route the
  // other roles to their actual home instead of /dashboard, because
  // /dashboard itself redirects lawn users back to /lawn (an infinite loop
  // for any non-office lawn user).
  if (!FIELD_MGMT.has(role as never)) {
    if (role === "sales") redirect("/estimates");
    if (role === "accountant") redirect("/invoices");
    // crew (and any other field role) → today's route.
    redirect("/lawn/my-route");
  }
  // A superintendent is a field role with its own focused "My Route" surface;
  // the office dispatch hub (schedules, billing, weather, services) is not
  // theirs to act on, so send them to My Route instead of a hub full of tiles
  // that would bounce them. PM stays — they oversee routes + seasonal.
  if (role === "superintendent") redirect("/lawn/my-route");

  const officeLike = isOfficeLike(role);
  const officeOrPm = OFFICE_OR_PM.has(role as never);

  const today = new Date().toISOString().slice(0, 10);

  // Today's Route + recurring schedules + the office notifications feed. RLS
  // scopes all of them to this user's org. The notifications query mirrors
  // /dashboard: lawn office users redirect to /lawn and never load /dashboard,
  // so the customer-action feed (estimate accepted/declined, invoice paid) is
  // surfaced here instead.
  const [
    { data: visits },
    { data: schedules },
    { data: notificationsData },
    { count: crewCount },
    { count: unreadRaw },
  ] = await Promise.all([
    supabase
      .from("lawn_visits")
      .select("id, due_date, status, jobs(name, address, customers(name))")
      .eq("status", "pending")
      .lte("due_date", today)
      .order("due_date", { ascending: true }),
    supabase
      .from("recurring_schedules")
      .select(
        "id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, service_type, price_per_visit, active, jobs(name, customers(name))"
      )
      .order("active", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("notifications")
      .select("id, type, title, body, href, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    // Solo-owner field mode: an office/admin with zero crew_members is the
    // field worker. Surfaced as a "Today's Route" link to /lawn/my-route (which
    // admits them in solo mode). Dispatchers with crews never see the link, so
    // there's no dead redirect for them. head+count = one cheap round-trip,
    // folded into the existing Promise.all (no extra serial query).
    supabase.from("crew_members").select("id", { count: "exact", head: true }),
    // Unread notifications for the KPI strip. Same table + same RLS scope as
    // the feed above, so this adds no new exposure — just a count.
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
  ]);

  const visitRows = (visits as unknown as VisitRow[] | null) ?? [];
  const scheduleRows = (schedules as unknown as ScheduleRow[] | null) ?? [];
  const notifications = (notificationsData ?? []) as Array<{
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    read_at: string | null;
    created_at: string;
  }>;
  const unreadCount = unreadRaw ?? 0;

  // Solo-owner field mode (see crew_members count above). The office/admin
  // owner running the work with no crews gets a "Today's Route" link into the
  // crew's streamlined My Route field flow (mark done / skip / photos / nav).
  const solo = officeLike && (crewCount ?? 0) === 0;

  // KPI values — derived in JS from rows already fetched (no extra queries).
  // The visits query is already `status=pending AND due_date <= today`, so
  // these two partitions cover it exactly.
  const todayCount = visitRows.filter((v) => v.due_date === today).length;
  const overdueCount = visitRows.filter((v) => v.due_date < today).length;
  const activeScheduleCount = scheduleRows.filter((s) => s.active).length;

  // Honest freshness line: SSR counts, recomputed each navigation + on PTR.
  const dateStr = new Date().toLocaleDateString();

  const showHubTools = officeLike || officeOrPm;

  return (
    <PageContainer
      title="Lawn"
      subtitle="Recurring routes & today's visits"
      maxWidth="wide"
      mainClassName="space-y-6"
    >
      <RoleOnboarding role={role} variant="lawn" />
      <ClientPullToRefresh>
        <div className="space-y-6">
          {/* KPI strip — the dispatch numbers that decide what to do next.
              Tone flags the exception (overdue work, unread customer actions);
              a clean board stays visually quiet. */}
          {showHubTools && (
            <div className="space-y-2">
              {/* "Will today actually work?" — persistent solo/crew readiness
                  answer from @/lib/fieldReadiness. Above the KPI strip because
                  it answers the question those counts feed into. Solo mode is
                  rendered as reassurance, never a call to action (the rule is
                  enforced inside the component + the lib). */}
              <FieldReadinessBanner />
              <p className="text-[11px] text-gray-400">
                As of {dateStr} · live counts
              </p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                <Link
                  href="/lawn/calendar"
                  className="block rounded-lg hover:shadow-md transition-shadow"
                >
                  <KpiTile
                    label="Today's visits"
                    value={String(todayCount)}
                    sub="due today"
                    icon={CalendarDays}
                  />
                </Link>
                <Link
                  href="/lawn/calendar"
                  className="block rounded-lg hover:shadow-md transition-shadow"
                >
                  <KpiTile
                    label="Overdue"
                    value={String(overdueCount)}
                    sub="past due date"
                    icon={CalendarDays}
                    tone={overdueCount > 0 ? "red" : "default"}
                  />
                </Link>
                {/* No /lawn/schedules index route exists (only
                    /lawn/schedules/[id]) — the schedules list IS the card
                    below, so this tile is deliberately not a link. */}
                <KpiTile
                  label="Active schedules"
                  value={String(activeScheduleCount)}
                  sub={`${scheduleRows.length} total`}
                  icon={Sprout}
                />
                {/* No notifications list page on either variant — plain tile. */}
                <KpiTile
                  label="Unread"
                  value={String(unreadCount)}
                  sub="notifications"
                  icon={Bell}
                  tone={unreadCount > 0 ? "blue" : "default"}
                />
              </div>
            </div>
          )}

          {/* Desktop 3-col: the dispatch lists get the wide column, the action
              rail sits beside them. Collapses to one column on mobile in DOM
              order (Today, Schedules, then the rail). */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:items-start">
            {/* ---- MAIN --------------------------------------------------- */}
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader title="Today" subtitle={`${visitRows.length} due`} />
                {visitRows.length === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title="Nothing due today"
                    description="Pending lawn visits due today or overdue will show up here."
                  />
                ) : (
                  <div className="divide-y divide-gray-100">
                    {visitRows.map((v) => {
                      const jobName = v.jobs?.name ?? "—";
                      const custName = v.jobs?.customers?.name ?? null;
                      return (
                        <Link
                          key={v.id}
                          href={`/lawn/visits/${v.id}`}
                          className="flex justify-between items-start gap-2 py-3 active:bg-gray-50"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-900 truncate">
                              {jobName}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              {custName ? `${custName} · ` : ""}
                              {v.jobs?.address ?? "—"}
                            </p>
                          </div>
                          <span
                            className={`text-[10px] font-semibold px-2 py-1 rounded ${
                              STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600"
                            } whitespace-nowrap`}
                          >
                            {dueLabel(v.due_date)}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card>
                <CardHeader
                  title="Recurring schedules"
                  subtitle={`${scheduleRows.length} total`}
                />
                {scheduleRows.length === 0 ? (
                  <EmptyState
                    icon={Sprout}
                    title="No recurring schedules yet"
                    description="Create a lawn job to set up a recurring route."
                    action={
                      officeLike ? (
                        <Link
                          href="/lawn/new"
                          className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold"
                        >
                          <Plus className="w-4 h-4" />
                          New lawn job
                        </Link>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="divide-y divide-gray-100">
                    {scheduleRows.map((s) => {
                      const jobName = s.jobs?.name ?? "—";
                      const custName = s.jobs?.customers?.name ?? null;
                      const sched = {
                        frequency: s.frequency,
                        days_of_week: s.days_of_week,
                        day_of_month: s.day_of_month,
                        price_per_visit: Number(s.price_per_visit) || 0,
                      };
                      return (
                        <Link
                          key={s.id}
                          href={`/lawn/schedules/${s.id}`}
                          className="flex justify-between items-start gap-2 py-3 active:bg-gray-50"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-900 truncate">
                              {jobName}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              {custName ? `${custName} · ` : ""}
                              {s.service_type ?? "Service"}
                              {!s.active && " · paused"}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {summarizeSchedule(sched)}
                            </p>
                          </div>
                          <span
                            className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${
                              s.active
                                ? "bg-green-100 text-green-700"
                                : "bg-gray-100 text-gray-500"
                            }`}
                          >
                            {s.active ? "Active" : "Paused"}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>

            {/* ---- SIDE --------------------------------------------------- */}
            <div className="space-y-6">
              {/* Solo owner: the single most important link on the page — they
                  ARE the crew. Keeps its green: this is a lawn surface accent,
                  not a Button primary (those stay blue on both deploys). */}
              {solo && (
                <Link
                  href="/lawn/my-route"
                  className="block bg-green-600 text-white text-center py-3 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2"
                >
                  <Sprout className="w-5 h-5" />
                  Today&rsquo;s Route
                </Link>
              )}

              {/* Quick actions — the old tile sections, compacted into a rail.
                  Every tile keeps its original role guard + destination, so a
                  viewer never sees a tile that would bounce them. */}
              {showHubTools && (
                <Card>
                  <CardHeader title="Quick actions" />

                  <p className={GROUP_LABEL}>Plan</p>
                  <div className="grid grid-cols-2 gap-2">
                    {/* Headline lawn feature (user verdict, docs/handoff-
                        estimator-v2): first action in the rail, not buried.
                        Label matches the "Quick quote" naming used on the
                        Estimates page's New menu (was "Measure & quote" —
                        renamed as part of the Estimates-tab consolidation). */}
                    {officeLike && (
                      <LinkButton href="/estimates/quick" variant="secondary" size="sm">
                        <Ruler className="w-4 h-4" />
                        Quick quote
                      </LinkButton>
                    )}
                    {officeLike && (
                      <LinkButton href="/lawn/new" variant="secondary" size="sm">
                        <Plus className="w-4 h-4" />
                        New lawn job
                      </LinkButton>
                    )}
                    {officeLike && (
                      <LinkButton href="/lawn/calendar" variant="secondary" size="sm">
                        <Calendar className="w-4 h-4" />
                        Route calendar
                      </LinkButton>
                    )}
                    {officeLike && (
                      <LinkButton href="/lawn/routes" variant="secondary" size="sm">
                        <Route className="w-4 h-4" />
                        Routes
                      </LinkButton>
                    )}
                    {officeOrPm && (
                      <LinkButton href="/lawn/seasonal" variant="secondary" size="sm">
                        <Snowflake className="w-4 h-4" />
                        Seasonal
                      </LinkButton>
                    )}
                    {officeLike && (
                      <LinkButton href="/lawn/weather" variant="secondary" size="sm">
                        <CloudSun className="w-4 h-4" />
                        Weather
                      </LinkButton>
                    )}
                  </div>

                  {officeLike && (
                    <>
                      <p className={GROUP_LABEL}>Customers &amp; service</p>
                      <div className="grid grid-cols-2 gap-2">
                        <LinkButton href="/admin/customers" variant="secondary" size="sm">
                          <Contact className="w-4 h-4" />
                          Customers
                        </LinkButton>
                        <LinkButton href="/lawn/services" variant="secondary" size="sm">
                          <Scissors className="w-4 h-4" />
                          Services
                        </LinkButton>
                      </div>
                    </>
                  )}

                  {officeLike && (
                    <>
                      <p className={GROUP_LABEL}>Money</p>
                      <div className="grid grid-cols-2 gap-2">
                        <LinkButton href="/lawn/billing" variant="secondary" size="sm">
                          <FileText className="w-4 h-4" />
                          Billing
                        </LinkButton>
                        <LinkButton href="/invoices" variant="secondary" size="sm">
                          <Users className="w-4 h-4" />
                          Invoices
                        </LinkButton>
                      </div>
                    </>
                  )}

                  <p className={GROUP_LABEL}>Insights</p>
                  <div className="grid grid-cols-2 gap-2">
                    <LinkButton href="/lawn/insights" variant="secondary" size="sm">
                      <TrendingUp className="w-4 h-4" />
                      Insights
                    </LinkButton>
                  </div>
                </Card>
              )}

              {/* Recent activity — customer-action notifications. Surfaced here
                  because lawn office users land on /lawn, not /dashboard.
                  RLS-scoped to this org. NotificationsFeed renders its own
                  "Notifications" heading + white box, so no Card wrapper. */}
              <NotificationsFeed notifications={notifications} />
            </div>
          </div>
        </div>
      </ClientPullToRefresh>
    </PageContainer>
  );
}
