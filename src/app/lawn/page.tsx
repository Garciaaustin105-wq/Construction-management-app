import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import { FIELD_MGMT, OFFICE_OR_PM, isOfficeLike } from "@/lib/roles";
import { summarizeSchedule } from "@/lib/lawnRecurrence";
import NotificationsFeed from "@/components/NotificationsFeed";
import RoleOnboarding from "@/components/RoleOnboarding";
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

// Small uppercase section divider — matches the local SectionHeader used on
// /dashboard (each page keeps its own so the hub reads as grouped sections, not
// a flat tile soup). Keep it a div, not a competing heading.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">
      {children}
    </h2>
  );
}

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
  // scopes all three to this user's org. The notifications query mirrors
  // /dashboard: lawn office users redirect to /lawn and never load /dashboard,
  // so the customer-action feed (estimate accepted/declined, invoice paid) is
  // surfaced here instead.
  const [{ data: visits }, { data: schedules }, { data: notificationsData }] =
    await Promise.all([
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Lawn" subtitle="Recurring routes & today's visits" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-6">
        <RoleOnboarding role={role} variant="lawn" />

        {/* ── Today — the actionable dispatch list (top of page) ───────── */}
        <section className="space-y-2">
          <SectionHeader>Today</SectionHeader>
          {visitRows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={CalendarDays}
                title="Nothing due today"
                description="Pending lawn visits due today or overdue will show up here."
              />
            </div>
          ) : (
            <div className="space-y-2">
              {visitRows.map((v) => {
                const jobName = v.jobs?.name ?? "—";
                const custName = v.jobs?.customers?.name ?? null;
                return (
                  <Link
                    key={v.id}
                    href={`/lawn/visits/${v.id}`}
                    className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
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
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Recurring schedules ──────────────────────────────────────── */}
        <section className="space-y-2">
          <SectionHeader>Recurring schedules</SectionHeader>
          {scheduleRows.length === 0 ? (
            <div className="bg-white rounded-lg">
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
            </div>
          ) : (
            <div className="space-y-2">
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
                    className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
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
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Plan — dispatch & scheduling tools ────────────────────────
            Tiles are role-gated to their destination page's admission set so
            a viewer never sees a tile that would bounce them (audit #6). */}
        {(officeLike || officeOrPm) && (
          <section className="space-y-2">
            <SectionHeader>Plan</SectionHeader>
            <div className="grid grid-cols-2 gap-2">
              {officeLike && (
                <Link
                  href="/lawn/new"
                  className="block bg-green-600 text-white text-center py-3 rounded-lg font-semibold active:bg-green-700 flex items-center justify-center gap-2"
                >
                  <Plus className="w-5 h-5" />
                  New lawn job
                </Link>
              )}
              {officeLike && (
                <Link
                  href="/lawn/calendar"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Calendar className="w-5 h-5" />
                  Route calendar
                </Link>
              )}
              {officeLike && (
                <Link
                  href="/lawn/routes"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Route className="w-5 h-5" />
                  Routes
                </Link>
              )}
              {officeOrPm && (
                <Link
                  href="/lawn/seasonal"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Snowflake className="w-5 h-5" />
                  Seasonal
                </Link>
              )}
              {officeLike && (
                <Link
                  href="/lawn/weather"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <CloudSun className="w-5 h-5" />
                  Weather
                </Link>
              )}
            </div>
          </section>
        )}

        {/* ── Customers & service ─────────────────────────────────────── */}
        {officeLike && (
          <section className="space-y-2">
            <SectionHeader>Customers &amp; service</SectionHeader>
            <div className="grid grid-cols-2 gap-2">
              <Link
                href="/admin/customers"
                className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <Contact className="w-5 h-5" />
                Customers
              </Link>
              <Link
                href="/lawn/services"
                className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <Scissors className="w-5 h-5" />
                Services
              </Link>
            </div>
          </section>
        )}

        {/* ── Money — billing & invoices ────────────────────────────────
            "Record payment" (cash/check) lands here in Phase C. */}
        {officeLike && (
          <section className="space-y-2">
            <SectionHeader>Money</SectionHeader>
            <div className="grid grid-cols-2 gap-2">
              <Link
                href="/lawn/billing"
                className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <FileText className="w-5 h-5" />
                Billing
              </Link>
              <Link
                href="/invoices"
                className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <Users className="w-5 h-5" />
                Invoices
              </Link>
            </div>
          </section>
        )}

        {/* ── Insights — owner analytics (admits every hub viewer) ────── */}
        <section className="space-y-2">
          <SectionHeader>Insights</SectionHeader>
          <Link
            href="/lawn/insights"
            className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <TrendingUp className="w-5 h-5" />
            Insights
          </Link>
        </section>

        {/* ── Recent activity — customer-action notifications ──────────
            Surfaced here because lawn office users land on /lawn, not
            /dashboard. RLS-scoped to this org. NotificationsFeed renders its
            own "Notifications" label (same as /dashboard), so no SectionHeader
            here — that would double up. */}
        <section>
          <NotificationsFeed notifications={notifications} />
        </section>
      </main>
    </div>
  );
}