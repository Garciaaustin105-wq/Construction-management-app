import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState from "@/components/EmptyState";
import Card, { CardHeader } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import KpiTile from "@/components/charts/KpiTile";
import DensityToggle from "@/components/ui/DensityToggle";
import { formatMoney } from "@/lib/money";
import { FIELD_MGMT, OFFICE_OR_PM, isOfficeLike } from "@/lib/roles";
import { generateDueDates, summarizeSchedule } from "@/lib/lawnRecurrence";
import NotificationsFeed from "@/components/NotificationsFeed";
import RoleOnboarding from "@/components/RoleOnboarding";
import FieldReadinessBanner from "@/components/FieldReadinessBanner";
import { getMe } from "@/lib/tenant";
import { todayInZone } from "@/lib/orgDate";
import { TodayVisitPeekList } from "@/components/VisitPeekModal";
import { isLawn } from "@/lib/variant";
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
  ClipboardCheck,
  Receipt,
} from "lucide-react";

// Row shapes for the relation joins (Supabase types these loosely, so we cast
// via `as unknown as Row[]` — same pattern as estimates/page.tsx).
// "8:00a - 10:00a" from the two time columns, or null when the visit carries
// no window. A start with no end is still worth showing - it is when the crew
// is due - so it renders alone rather than being dropped.
function visitWindow(v: {
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
}): string | null {
  const clock = (t: string | null) => {
    if (!t) return null;
    const [hRaw, m] = t.split(":");
    const h = Number(hRaw);
    if (!Number.isFinite(h)) return null;
    const suffix = h < 12 ? "a" : "p";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m ?? "00"}${suffix}`;
  };
  const start = clock(v.scheduled_window_start);
  const end = clock(v.scheduled_window_end);
  if (!start && !end) return null;
  if (start && end) return `${start} - ${end}`;
  return start ?? end;
}

// The next date this schedule actually lands, or null.
//
// A PAUSED schedule returns null rather than its would-be date: the column asks
// when the crew is next going, and for a paused route the answer is not a date.
// The 90-day window bounds the work — a monthly schedule needs more than a
// fortnight to produce anything, and a schedule with nothing inside three
// months is not something the office is planning around today.
function nextDue(
  s: ScheduleRow,
  today: string
): string | null {
  if (!s.active) return null;
  const horizon = new Date(
    new Date(`${today}T00:00:00Z`).valueOf() + 90 * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  return generateDueDates(s, today, horizon)[0] ?? null;
}

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
  // Desktop-table columns. All nullable: a visit created by hand has no
  // schedule behind it, may not be assigned to a crew, and need not carry an
  // arrival window. Each renders as an em dash rather than a guess.
  route_order: number | null;
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  recurring_schedules: { service_type: string | null } | null;
  crew_teams: { name: string | null } | null;
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

// Overline for a Quick Actions group — matches /dashboard's sidebar.
const GROUP_LABEL =
  "text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-3 first:mt-0";

// Desktop hero greeting (lawn only — construction renders nothing here, see
// the isLawn() gate at the call site, so no construction equivalent needed).
const GREETING_TITLE =
  "font-display text-[26px] font-semibold text-foreground tracking-[-0.01em] leading-tight";
const GREETING_SUB = "text-sm text-muted mt-1";

// "Recurring schedules" DESKTOP table styling. This table sits inside a
// `hidden lg:block` wrapper only — the mobile list a few lines down is a
// separate element with its own hardcoded classes — so retinting it here
// cannot change what a phone renders in either variant. Construction keeps
// the original gray-* Tailwind classes verbatim; lawn switches to the
// surface/border/text tokens already established in Card.tsx/KpiTile.tsx.
const TABLE_HEAD_ROW = isLawn() ? "border-b border-line-soft" : "border-b border-gray-200";
const TABLE_HEAD_CELL = isLawn() ? "text-muted" : "text-gray-400";
const TABLE_BODY_DIVIDE = isLawn() ? "divide-y divide-line-soft" : "divide-y divide-gray-100";
const TABLE_ROW_HOVER = isLawn() ? "hover:bg-surface-muted" : "hover:bg-gray-50";
const TABLE_JOB_LINK = isLawn()
  ? "font-semibold text-foreground hover:underline"
  : "font-semibold text-gray-900 hover:underline";
const TABLE_CUST_SUB = isLawn() ? "text-muted" : "text-gray-500";
const TABLE_CADENCE = isLawn() ? "text-muted-strong" : "text-gray-700";
const TABLE_PRICE = isLawn() ? "font-num text-foreground" : "text-gray-900";
const TABLE_NEXT_DUE = isLawn() ? "font-num text-muted-strong" : "text-gray-700";
const TABLE_STATUS_ACTIVE = isLawn() ? "bg-success/15 text-success" : "bg-green-100 text-green-700";
const TABLE_STATUS_PAUSED = isLawn() ? "bg-surface-muted text-muted" : "bg-gray-100 text-gray-500";

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

  // "Today" where the BUSINESS is, not where the Vercel server is (UTC): the
  // old toISOString() day shifted every evening from 20:00 Eastern, labelling
  // today's visits "Overdue" and tomorrow's "Today". One small read before the
  // parallel block because the visits query below filters on the result.
  let orgTz: string | null = null;
  if (me.orgId) {
    const { data: orgTzRow } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", me.orgId)
      .maybeSingle();
    orgTz = (orgTzRow as { timezone: string | null } | null)?.timezone ?? null;
  }
  const today = todayInZone(orgTz);

  // Today's Route + recurring schedules + the office notifications feed. RLS
  // scopes all of them to this user's org. The notifications query mirrors
  // /dashboard: lawn office users redirect to /lawn and never load /dashboard,
  // so the customer-action feed (estimate accepted/declined, invoice paid) is
  // surfaced here instead.
  // Seven days back from the ORG's today, not the server's clock — a Florida
  // office at 9pm and the machine running this are not always on the same date,
  // and the tile says "last 7 days" so the window has to mean the org's days.
  // Deriving it from `today` also keeps this pure, which is what
  // react-hooks/purity wants: parsing a date string reads no clock.
  const weekAgoIso = new Date(
    new Date(`${today}T00:00:00Z`).valueOf() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const [
    { data: visits },
    { data: schedules },
    { data: notificationsData },
    { count: crewCount },
    { count: unreadRaw },
    { count: approvalsRaw },
    { data: recentInvoices },
  ] = await Promise.all([
    // The extra columns are for the DESKTOP table only (service, crew and the
    // arrival window). They are on lawn_visits and its two FKs already, so this
    // is a wider select on a query that was being made anyway - not a new
    // round trip. Mobile ignores them.
    supabase
      .from("lawn_visits")
      .select(
        "id, due_date, status, route_order, scheduled_window_start, scheduled_window_end, jobs(name, address, customers(name)), recurring_schedules(service_type), crew_teams(name)"
      )
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
    // Finished visits waiting on the office (gate 4). Same filter the
    // approvals queue itself uses; head+count so this is a count, not a page
    // of rows.
    supabase
      .from("lawn_visits")
      .select("id", { count: "exact", head: true })
      .not("awaiting_approval_since", "is", null),
    // Invoiced in the last SEVEN DAYS - not "this week". There is no total
    // column on invoices, so the figure is summed from line items, and the
    // window is what keeps that cheap: /admin/insights pulls thirteen months
    // for its charts and is the slowest page in the app. Seven days is also
    // the honest label; a Monday-boundary "this week" reads as almost nothing
    // every Monday morning.
    supabase
      .from("invoices")
      .select("id, invoice_line_items(quantity, unit_price)")
      .gte("created_at", weekAgoIso),
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
  const approvalsCount = approvalsRaw ?? 0;

  // Summed here rather than in SQL because the line items came back with the
  // invoices. A quantity or price that is null counts as zero - a missing
  // figure is not a negative one.
  const invoicedWeek = (
    (recentInvoices ?? []) as Array<{
      invoice_line_items: Array<{ quantity: number | null; unit_price: number | null }> | null;
    }>
  ).reduce(
    (sum, inv) =>
      sum +
      (inv.invoice_line_items ?? []).reduce(
        (n, li) => n + (Number(li.quantity) || 0) * (Number(li.unit_price) || 0),
        0
      ),
    0
  );
  const invoicedCount = (recentInvoices ?? []).length;

  // Solo-owner field mode (see crew_members count above). The office/admin
  // owner running the work with no crews gets a "Today's Route" link into the
  // crew's streamlined My Route field flow (mark done / skip / photos / nav).
  const solo = officeLike && (crewCount ?? 0) === 0;

  // KPI values — derived in JS from rows already fetched (no extra queries).
  // The visits query is already `status=pending AND due_date <= today`, so
  // these two partitions cover it exactly.
  // The query fetches due_date <= today, so visitRows is today's work PLUS the
  // whole overdue backlog. Split it: a card titled "Today" that lists visits
  // from last week is not a today list, and it made a growing backlog look like
  // a growing day. Overdue has its own page (the KPI tile below links there,
  // and the daily digest points at it too).
  const todayVisits = visitRows.filter((v) => v.due_date === today);
  const todayCount = todayVisits.length;
  const overdueCount = visitRows.filter((v) => v.due_date < today).length;
  const activeScheduleCount = scheduleRows.filter((s) => s.active).length;

  // Honest freshness line: SSR counts, recomputed each navigation + on PTR.
  const dateStr = new Date().toLocaleDateString();

  const showHubTools = officeLike || officeOrPm;

  // Desktop hero greeting (lawn only, see render below). Reads data already
  // fetched by getMe() for this render — no new query. Server-local clock,
  // same convention as `dateStr` above (SSR, recomputed each navigation).
  const greetHour = new Date().getHours();
  const greeting =
    greetHour < 12 ? "Good morning" : greetHour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (me.user.user_metadata as { full_name?: string } | undefined)
    ?.full_name?.split(" ")[0];
  const greetingDateStr = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

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
          {/* Desktop hero — Fraunces greeting naming the person and the day.
              Lawn only, lg and up: the phone keeps its existing compact
              TopBar ("Lawn" / "Recurring routes & today's visits") and
              construction is untouched. Purely presentational — no new
              query, name/org come from getMe(), already fetched above. */}
          {isLawn() && (
            <div className="hidden lg:block">
              <h1 className={GREETING_TITLE}>
                {greeting}
                {firstName ? `, ${firstName}` : ""}
              </h1>
              <p className={GREETING_SUB}>
                {greetingDateStr} · {me.orgName}
              </p>
            </div>
          )}

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
              {/* The row only becomes a row at lg. Below that it is an inert
                  wrapper and the freshness line keeps exactly the classes it
                  had, so the phone renders what it always did. */}
              <div className="lg:flex lg:items-center lg:gap-2">
                <p className="text-[11px] text-gray-400 lg:flex-1">
                  As of {dateStr} · live counts
                </p>
                {/* Built in phase 1 of the desktop pass and never mounted —
                    "phase 3 mounts it in the desktop page header". This is that
                    header. It stamps data-density on <html>, so one click
                    re-densifies every shared table at once; it hides itself
                    below lg, where the tokens are not read at all. */}
                {/* Desktop only. The density tokens are read by desktop
                    tables alone, so offering the control on a phone would set
                    something the viewer cannot see. */}
                <DensityToggle className="hidden lg:inline-flex" />
              </div>
              {/* Six-up at lg, still 2-up on a phone. The desktop strip reads
                  as one row of dispatch numbers; the phone keeps the grid it
                  had. Approvals and Invoiced were added here because the row
                  had space on a wide screen and both are questions the office
                  asks before nine. */}
              <div className="grid grid-cols-2 lg:grid-cols-6 gap-2.5">
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
                {/* Overdue is its own backlog page now (/lawn/overdue — the
                    daily digest links there too), not a calendar filter. */}
                <Link
                  href="/lawn/overdue"
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
                {/* Gate 4: finished work the customer is not told about until
                    the office says so. Amber rather than red — it is a queue,
                    not a failure. */}
                {/* The two tiles below are DESKTOP ONLY. The desktop pass has
                    one hard rule — lg and up, mobile unchanged — and a phone
                    showing six tiles in a two-column grid is three rows of
                    numbers before the day's work. */}
                <Link
                  href="/lawn/approvals"
                  className="hidden lg:block rounded-lg hover:shadow-md transition-shadow"
                >
                  <KpiTile
                    label="Approvals"
                    value={String(approvalsCount)}
                    sub="awaiting office"
                    icon={ClipboardCheck}
                    tone={approvalsCount > 0 ? "amber" : "default"}
                  />
                </Link>
                {/* Seven days, and the label says seven days. "This week" would
                    read as almost nothing every Monday morning. */}
                <Link
                  href="/invoices"
                  className="hidden lg:block rounded-lg hover:shadow-md transition-shadow"
                >
                  <KpiTile
                    label="Invoiced"
                    value={formatMoney(invoicedWeek)}
                    sub={`${invoicedCount} in last 7 days`}
                    icon={Receipt}
                  />
                </Link>
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
                <CardHeader title="Today" subtitle={`${todayCount} due`} />
                {todayCount === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title="Nothing due today"
                    // If the day is clear but a backlog exists, say so here
                    // rather than leaving the page looking finished.
                    description={
                      overdueCount > 0
                        ? `Nothing scheduled for today, but ${overdueCount} ${
                            overdueCount === 1 ? "visit is" : "visits are"
                          } past their due date.`
                        : "Pending lawn visits due today will show up here."
                    }
                  />
                ) : (
                  // Rows open the shared peek modal instead of navigating to
                  // /lawn/visits/[id] — the data is already on the page, so a
                  // navigation was a Vercel invocation to re-read it. The visit
                  // page stays reachable from inside the modal for editing.
                  <TodayVisitPeekList
                    today={today}
                    visits={todayVisits.map((v) => ({
                      id: v.id,
                      dueDate: v.due_date,
                      status: v.status,
                      jobName: v.jobs?.name ?? "—",
                      customerName: v.jobs?.customers?.name ?? null,
                      address: v.jobs?.address ?? null,
                      serviceType: v.recurring_schedules?.service_type ?? null,
                      crewName: v.crew_teams?.name ?? null,
                      windowLabel: visitWindow(v),
                      routeOrder: v.route_order,
                      notes: null,
                    }))}
                  />
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
                  <>
                  {/*
                    DESKTOP TABLE. Five columns: what, how often, what it earns
                    per visit, when it next lands, and whether it is running.
                    Money is right-aligned and tabular so a column of prices
                    can be read down, which is the entire reason a table beats
                    the stacked list on a wide screen.

                    Mobile keeps the list below, unchanged.
                  */}
                  <div className="hidden lg:block overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className={TABLE_HEAD_ROW}>
                          {["Job", "Cadence", "Price / visit", "Next due", "Status"].map(
                            (h, i) => (
                              <th
                                key={h}
                                className={`py-2 pr-3 text-[10px] font-semibold uppercase tracking-wide ${TABLE_HEAD_CELL} ${
                                  i === 2 ? "text-right" : ""
                                }`}
                              >
                                {h}
                              </th>
                            )
                          )}
                        </tr>
                      </thead>
                      <tbody className={TABLE_BODY_DIVIDE}>
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
                            <tr key={s.id} className={TABLE_ROW_HOVER}>
                              <td className="py-[var(--row-py)] pr-3 text-[length:var(--row-fs)]">
                                <Link
                                  href={`/lawn/schedules/${s.id}`}
                                  className={TABLE_JOB_LINK}
                                >
                                  {jobName}
                                </Link>
                                {custName && (
                                  <span className={`block text-xs truncate ${TABLE_CUST_SUB}`}>
                                    {custName}
                                  </span>
                                )}
                              </td>
                              <td className={`py-[var(--row-py)] pr-3 text-[length:var(--row-fs)] ${TABLE_CADENCE}`}>
                                {summarizeSchedule(sched)}
                              </td>
                              {/* Right-aligned and tabular: a column of prices
                                  is meant to be read down. 0 shows as a dash,
                                  because a schedule with no price recorded is
                                  not a free one. */}
                              <td className={`py-[var(--row-py)] pr-3 text-[length:var(--row-fs)] text-right tabular-nums ${TABLE_PRICE}`}>
                                {sched.price_per_visit > 0
                                  ? formatMoney(sched.price_per_visit)
                                  : "—"}
                              </td>
                              <td className={`py-[var(--row-py)] pr-3 text-[length:var(--row-fs)] tabular-nums ${TABLE_NEXT_DUE}`}>
                                {nextDue(s, today) ?? "—"}
                              </td>
                              <td className="py-[var(--row-py)] text-[length:var(--row-fs)]">
                                <span
                                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${
                                    s.active ? TABLE_STATUS_ACTIVE : TABLE_STATUS_PAUSED
                                  }`}
                                >
                                  {s.active ? "Active" : "Paused"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="divide-y divide-gray-100 lg:hidden">
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
                  </>
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
                  <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap">
                    {/* Headline lawn feature (user verdict, docs/handoff/handoff-
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
                      <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap">
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
                      <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap">
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
                  <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap">
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
