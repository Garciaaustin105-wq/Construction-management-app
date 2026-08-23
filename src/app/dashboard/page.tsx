import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import PageContainer from "@/components/PageContainer";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import Card, { CardHeader } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import KpiTile from "@/components/charts/KpiTile";
import { formatMoney, computeTotal } from "@/lib/money";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import Link from "next/link";
import { Plus, Receipt, Clock, Tag, Calculator, Images, Briefcase, Building2, FileSpreadsheet, Users, Building, Calendar, TrendingUp, ClipboardList, CheckSquare, FileDiff, FileText, Terminal } from "lucide-react";
import { MANAGEMENT, isSuperAdmin } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import PlanBanner from "@/components/PlanBanner";
import NotificationsFeed from "@/components/NotificationsFeed";
import RoleOnboarding from "@/components/RoleOnboarding";

// Job status → badge tone. Domain-specific to jobs (estimate/invoice statuses
// have their own maps on their own pages), so the map lives with the page that
// renders it — the shared StatusBadge stays tone-only.
const JOB_TONE: Record<string, BadgeTone> = {
  scheduled: "neutral",
  in_progress: "warning",
  on_hold: "danger",
  completed: "success",
};

// Overline for a Quick Actions group. Understated on purpose — these label a
// dense sidebar of links, they aren't headings competing with card titles.
const GROUP_LABEL =
  "text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-3 first:mt-0";

export default async function DashboardPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const { user } = me;

  // No profile row means the auth user exists but no workspace was created
  // (e.g. a signup that didn't persist the profile, or a dashboard-created
  // auth user with no profile). Don't silently drop them into a crew view that
  // looks like a successful login to the wrong project — surface the broken
  // state so it gets fixed. ("Users read own profile" is just id = auth.uid(),
  // so a null result reliably means no profile, not an RLS hiccup.)
  //
  // Deliberately NOT PageContainer: this is an error state, not the dashboard.
  // It keeps the bare shell so it can't pick up dashboard chrome.
  if (!me.hasProfile) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
        <TopBar title="Account not set up" showSignOut />
        <main className="max-w-md mx-auto p-4">
          <div className="bg-white rounded-lg p-6 space-y-3 text-center">
            <h1 className="text-lg font-bold text-gray-900">
              No workspace profile found
            </h1>
            <p className="text-sm text-gray-600">
              Your sign-in worked, but this account has no workspace profile
              attached. This happens when a signup doesn&apos;t complete. Please
              contact support (or the business owner) to finish setting up the
              account, then sign in again.
            </p>
            <p className="text-xs text-gray-400">
              Signed-in user: {user.email}
            </p>
          </div>
        </main>
      </div>
    );
  }

  const role = me.role;

  // Lawn variant: the lawn landing is /lawn (schedules + today's route). The
  // construction-oriented dashboard doesn't apply to a lawn org, so redirect
  // lawn users to /lawn — EXCEPT super_admin, who has no org and lands on the
  // platform block below (rendered on both variants).
  if (isLawn() && !isSuperAdmin(role)) redirect("/lawn");

  // Show the user's OWN organization name (not a hardcoded brand) so each
  // tenant sees their own workspace — otherwise every new business is labelled
  // "Terra Vista" and appears to be someone else's project. Folded into the
  // cached getMe() embed, so no separate organizations round trip.
  const orgName = me.orgName ?? "Workspace";

  // admin supersetes office on the office surface (grid, weekly report,
  // invoices, RFIs). super_admin does NOT get the office surface — they get a
  // platform view instead (they have no org, so the office grid would query
  // across all orgs).
  const showOfficeSurface = role === "office" || role === "admin";
  const showPlatform = isSuperAdmin(role);
  // Dedicated surfaces for the new roles so /dashboard is useful to them
  // (otherwise a sales/accountant user lands on a generic office grid they
  // can't act on, and a superintendent lands on office-manage clutter).
  const showSales = role === "sales";
  const showAccountant = role === "accountant";
  const showSuper = role === "superintendent";
  // Section visibility — each tile inside still keeps its own exact role guard;
  // these only decide whether a labeled section renders at all.
  const showCreate = showOfficeSurface || role === "project_manager";
  // Manage = office/admin/PM (was MANAGEMENT, which included superintendent —
  // a field role shouldn't be handed cost-code/sub management tiles).
  const showManage = role === "office" || role === "admin" || role === "project_manager";
  // Track (Time/Photos/Calendar/Reports) is the office surface; sales/accountant
  // get their own dedicated sections below instead of the generic Track.
  const showTrack =
    (showOfficeSurface || !showPlatform) && !showSales && !showAccountant;
  // Office-like (office/admin) see the customer-action feed (estimate
  // accepted/declined, invoice paid). RLS (tier_office) scopes the query to
  // the caller's org. super_admin is intentionally EXCLUDED: they have no org,
  // so same_org() bypasses tier_office and would surface every tenant's
  // notifications platform-wide. Per the "super_admin not tied to orgs" rule,
  // they get no org notification feed.
  const showNotifications = showOfficeSurface;

  // Fan out the independent reads in parallel (was sequential awaits, so the
  // dashboard waited on jobs → photos → rfis → invoices one after another).
  // The four head+count reads that feed the KPI strip ride in the SAME
  // Promise.all so the strip costs no serial round trips.
  const [
    jobsRes,
    photosRes,
    rfisRes,
    invoicesRes,
    notificationsRes,
    estimatesCountRes,
    unpaidCountRes,
    changeOrdersCountRes,
    dailyLogsCountRes,
  ] = await Promise.all([
      // super_admin (platform view) doesn't use jobs/photos — skip the
      // cross-org query (RLS would return every org's rows; not needed here).
      showPlatform
        ? Promise.resolve({ data: [] })
        : supabase
            .from("jobs")
            .select("id, name, status, customers(name)")
            .eq("type", "construction")
            .order("created_at", { ascending: false })
            .limit(8),
      showPlatform
        ? Promise.resolve({ data: [] })
        : supabase
            .from("photos")
            .select("id, storage_path, caption, created_at, jobs(name)")
            .order("created_at", { ascending: false })
            .limit(12),
      showOfficeSurface
        ? supabase
            .from("rfis")
            .select("id, question, status, created_at, jobs(name)")
            .order("created_at", { ascending: false })
            .limit(10)
        : Promise.resolve({ data: [] }),
      showOfficeSurface
        ? supabase
            .from("invoices")
            .select(
              "id, status, paid_at, created_at, jobs(name), customers(name), invoice_line_items(quantity, unit_price)"
            )
            .eq("status", "sent")
            .order("created_at", { ascending: false })
            .limit(5)
        : Promise.resolve({ data: [] }),
      showNotifications
        ? supabase
            .from("notifications")
            .select("id, type, title, body, href, read_at, created_at")
            .order("created_at", { ascending: false })
            .limit(10)
        : Promise.resolve({ data: [] }),
      // ---- KPI strip counts (office/admin only; head+count, no rows) --------
      // Filters mirror each list page's status map exactly, so a KPI tile and
      // the list it drills into can never disagree about what it's counting.
      // estimates open pipeline (draft + sent)
      showOfficeSurface
        ? supabase
            .from("estimates")
            .select("id", { count: "exact", head: true })
            .in("status", ["draft", "sent"])
        : Promise.resolve({ count: 0 }),
      // unpaid invoices (sent)
      showOfficeSurface
        ? supabase
            .from("invoices")
            .select("id", { count: "exact", head: true })
            .eq("status", "sent")
        : Promise.resolve({ count: 0 }),
      // change orders pending review (sent + submitted)
      showOfficeSurface
        ? supabase
            .from("change_orders")
            .select("id", { count: "exact", head: true })
            .in("status", ["sent", "submitted"])
        : Promise.resolve({ count: 0 }),
      // daily logs awaiting review (submitted)
      showOfficeSurface
        ? supabase
            .from("daily_logs")
            .select("id", { count: "exact", head: true })
            .eq("status", "submitted")
        : Promise.resolve({ count: 0 }),
    ]);

  const jobs = jobsRes.data;
  const photos = photosRes.data;
  const rfis = rfisRes.data;
  const unpaidInvoices = invoicesRes.data;
  const estimatesCount = estimatesCountRes.count ?? 0;
  const unpaidCount = unpaidCountRes.count ?? 0;
  const changeOrdersCount = changeOrdersCountRes.count ?? 0;
  const dailyLogsCount = dailyLogsCountRes.count ?? 0;
  const notifications = (notificationsRes.data ?? []) as Array<{
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    read_at: string | null;
    created_at: string;
  }>;

  // Visiting Home marks every visible job as "seen" so the notification badge
  // only counts activity that happens AFTER this visit (not old photos/RFIs on
  // jobs the user simply hasn't opened individually). Fire-and-forget so it
  // doesn't block the render.
  if (jobs && jobs.length > 0) {
    void supabase.from("job_views").upsert(
      jobs.map((j) => ({
        user_id: user.id,
        job_id: j.id,
        last_seen_at: new Date().toISOString(),
      })),
      { onConflict: "user_id,job_id" }
    );
  }

  const unpaidRows = (unpaidInvoices ?? []).map((inv) => {
    const items =
      (inv.invoice_line_items as unknown as { quantity: number; unit_price: number }[]) ?? [];
    return {
      id: inv.id,
      jobName: (inv.jobs as unknown as { name: string } | null)?.name ?? "—",
      customerName: (inv.customers as unknown as { name: string } | null)?.name ?? "—",
      createdAt: inv.created_at,
      total: computeTotal(items),
    };
  });

  const unpaidTotal = unpaidRows.reduce((sum, r) => sum + r.total, 0);

  // Honest freshness line: these are SSR counts, recomputed on every navigation
  // and on pull-to-refresh — not a cached snapshot, and not a live socket.
  const dateStr = new Date().toLocaleDateString();

  return (
    <PageContainer
      title={orgName}
      subtitle={`Signed in as ${role}`}
      maxWidth="wide"
      mainClassName="space-y-6"
    >
      <RoleOnboarding role={role} variant="construction" />
      <PlanBanner />
      <ClientPullToRefresh>
        {showPlatform ? (
          /* Super admin: platform view (no org, so no office grid, no KPIs). */
          <Card>
            <CardHeader title="Platform" subtitle="No organization attached" />
            <div className="space-y-2">
              <LinkButton href="/admin/orgs" block>
                <Building className="w-4 h-4" />
                Platform · All Organizations
              </LinkButton>
              <LinkButton href="/admin/users" variant="secondary" block>
                <Users className="w-4 h-4" />
                Users
              </LinkButton>
              <LinkButton href="/admin/dev" variant="secondary" block>
                <Terminal className="w-4 h-4" />
                Dev · Analytics &amp; system
              </LinkButton>
            </div>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* KPI strip — office/admin only. Every tile drills into the list
                it counts. Tone flags the exception, so a clean desk stays
                visually quiet and only the numbers needing action stand out. */}
            {showOfficeSurface && (
              <>
                <p className="text-[11px] text-gray-400 -mb-2">
                  As of {dateStr} · live counts
                </p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                  <Link
                    href="/estimates"
                    className="block rounded-lg hover:shadow-md transition-shadow"
                  >
                    <KpiTile
                      label="Estimates"
                      value={String(estimatesCount)}
                      sub="draft + sent"
                      icon={FileText}
                      tone={estimatesCount > 0 ? "amber" : "default"}
                    />
                  </Link>
                  <Link
                    href="/invoices?status=sent"
                    className="block rounded-lg hover:shadow-md transition-shadow"
                  >
                    <KpiTile
                      label="Unpaid"
                      value={String(unpaidCount)}
                      sub="awaiting payment"
                      icon={Receipt}
                      tone={unpaidCount > 0 ? "red" : "default"}
                    />
                  </Link>
                  <Link
                    href="/change-orders"
                    className="block rounded-lg hover:shadow-md transition-shadow"
                  >
                    <KpiTile
                      label="Change Orders"
                      value={String(changeOrdersCount)}
                      sub="pending review"
                      icon={FileDiff}
                      tone={changeOrdersCount > 0 ? "amber" : "default"}
                    />
                  </Link>
                  <Link
                    href="/daily-logs"
                    className="block rounded-lg hover:shadow-md transition-shadow"
                  >
                    <KpiTile
                      label="Daily Logs"
                      value={String(dailyLogsCount)}
                      sub="awaiting review"
                      icon={ClipboardList}
                      tone={dailyLogsCount > 0 ? "amber" : "default"}
                    />
                  </Link>
                </div>
              </>
            )}

            {/* Desktop 3-col: actionable lists get the wide column, the action
                rail sits beside them. Collapses to one column on mobile in DOM
                order (lists first, then the rail). lg:items-start stops a short
                card stretching to match a tall neighbor. */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:items-start">
              {/* ---- MAIN ------------------------------------------------- */}
              <div className="lg:col-span-2 space-y-6">
                <Card>
                  <CardHeader
                    title="Your Jobs"
                    subtitle={`${jobs?.length ?? 0} shown`}
                  />
                  {jobs && jobs.length > 0 ? (
                    <div className="divide-y divide-gray-100">
                      {jobs.map((job) => (
                        <Link
                          key={job.id}
                          href={`/jobs/${job.id}`}
                          className="flex justify-between items-start gap-2 py-3 active:bg-gray-50"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-900 truncate">
                              {job.name}
                            </p>
                            <p className="text-sm text-gray-500 truncate">
                              {(job.customers as unknown as { name: string } | null)?.name ?? "—"}
                            </p>
                          </div>
                          <StatusBadge tone={JOB_TONE[job.status] ?? "neutral"}>
                            {job.status.replace("_", " ")}
                          </StatusBadge>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      icon={EmptyIcons.Briefcase}
                      title="No jobs yet"
                      description={
                        showOfficeSurface
                          ? "Tap “New Project” above to create your first job."
                          : "Your assigned jobs will show up here once the office assigns them."
                      }
                    />
                  )}
                </Card>

                {showOfficeSurface && (
                  <Card>
                    <CardHeader
                      title="Unpaid Invoices"
                      action={
                        <LinkButton
                          href="/invoices?status=sent"
                          variant="secondary"
                          size="sm"
                        >
                          View all
                        </LinkButton>
                      }
                    />
                    {unpaidRows.length > 0 ? (
                      <>
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-2 flex justify-between items-center">
                          <span className="text-sm text-amber-800 font-medium">
                            {unpaidRows.length} invoice{unpaidRows.length === 1 ? "" : "s"} outstanding
                          </span>
                          <span className="text-base font-bold text-amber-900">
                            {formatMoney(unpaidTotal)}
                          </span>
                        </div>
                        <div className="divide-y divide-gray-100">
                          {unpaidRows.map((inv) => (
                            <Link
                              key={inv.id}
                              href={`/invoices/${inv.id}`}
                              className="flex justify-between items-start gap-2 py-3 active:bg-gray-50"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold text-gray-900 truncate">
                                  {inv.customerName}
                                </p>
                                <p className="text-xs text-gray-500 truncate">
                                  {inv.jobName} ·{" "}
                                  {new Date(inv.createdAt).toLocaleDateString()}
                                </p>
                              </div>
                              <span className="text-sm font-bold text-gray-900">
                                {formatMoney(inv.total)}
                              </span>
                            </Link>
                          ))}
                        </div>
                      </>
                    ) : (
                      <EmptyState
                        icon={EmptyIcons.FileText}
                        title="All paid up"
                        description="No outstanding invoices right now."
                      />
                    )}
                  </Card>
                )}

                {showOfficeSurface && (
                  <Card>
                    <CardHeader title="Recent RFIs" />
                    {rfis && rfis.length > 0 ? (
                      <div className="divide-y divide-gray-100">
                        {rfis.map((r) => (
                          <div key={r.id} className="py-3">
                            <p className="text-sm text-gray-900">{r.question}</p>
                            <p className="text-xs text-gray-500 mt-1">
                              {(r.jobs as unknown as { name: string } | null)?.name ?? "—"} ·{" "}
                              <span className="font-medium">{r.status}</span>
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        icon={EmptyIcons.Inbox}
                        title="No RFIs yet"
                        description="Submitted RFIs from your crew will appear here."
                      />
                    )}
                  </Card>
                )}
              </div>

              {/* ---- SIDE ------------------------------------------------- */}
              <div className="space-y-6">
                {/* Quick actions — the old full-width tile stack, compacted
                    into a sidebar. Every tile keeps its original role guard
                    and destination; only the presentation changed. */}
                <Card>
                  <CardHeader title="Quick actions" />

                  {showCreate && (
                    <>
                      <p className={GROUP_LABEL}>Create</p>
                      <div className="grid grid-cols-2 gap-2">
                        {showOfficeSurface && (
                          <>
                            <LinkButton href="/admin/projects/new" variant="secondary" size="sm">
                              <Plus className="w-4 h-4" />
                              New
                            </LinkButton>
                            <LinkButton href="/estimates" variant="secondary" size="sm">
                              <Calculator className="w-4 h-4" />
                              Estimates
                            </LinkButton>
                            <LinkButton href="/invoices/new" variant="secondary" size="sm">
                              <Receipt className="w-4 h-4" />
                              Invoice
                            </LinkButton>
                          </>
                        )}
                        {role === "project_manager" && (
                          <>
                            <LinkButton href="/invoices/new" variant="secondary" size="sm">
                              <Receipt className="w-4 h-4" />
                              Invoice
                            </LinkButton>
                            <LinkButton href="/invoices" variant="secondary" size="sm">
                              <Receipt className="w-4 h-4" />
                              All Invoices
                            </LinkButton>
                          </>
                        )}
                      </div>
                    </>
                  )}

                  {showSuper && (
                    <>
                      <p className={GROUP_LABEL}>Field</p>
                      <div className="grid grid-cols-2 gap-2">
                        <LinkButton href="/crew/time" variant="secondary" size="sm">
                          <Clock className="w-4 h-4" />
                          Time
                        </LinkButton>
                        <LinkButton href="/daily-logs" variant="secondary" size="sm">
                          <ClipboardList className="w-4 h-4" />
                          Logs
                        </LinkButton>
                        <LinkButton href="/punch" variant="secondary" size="sm">
                          <CheckSquare className="w-4 h-4" />
                          Punch
                        </LinkButton>
                        <LinkButton href="/change-orders" variant="secondary" size="sm">
                          <FileDiff className="w-4 h-4" />
                          Change Orders
                        </LinkButton>
                        <LinkButton href="/crew/photo" variant="secondary" size="sm">
                          <Images className="w-4 h-4" />
                          Photos
                        </LinkButton>
                      </div>
                    </>
                  )}

                  {showSales && (
                    <>
                      <p className={GROUP_LABEL}>Sales</p>
                      <div className="grid grid-cols-2 gap-2">
                        <LinkButton href="/estimates/new" variant="secondary" size="sm">
                          <FileText className="w-4 h-4" />
                          New Estimate
                        </LinkButton>
                        <LinkButton href="/estimates" variant="secondary" size="sm">
                          <FileText className="w-4 h-4" />
                          Estimates
                        </LinkButton>
                        <LinkButton href="/admin/customers" variant="secondary" size="sm">
                          <Building2 className="w-4 h-4" />
                          Leads
                        </LinkButton>
                        <LinkButton href="/admin/insights" variant="secondary" size="sm">
                          <TrendingUp className="w-4 h-4" />
                          Pipeline Insights
                        </LinkButton>
                      </div>
                    </>
                  )}

                  {showAccountant && (
                    <>
                      <p className={GROUP_LABEL}>Financials</p>
                      <div className="grid grid-cols-2 gap-2">
                        <LinkButton href="/invoices" variant="secondary" size="sm">
                          <Receipt className="w-4 h-4" />
                          Invoices
                        </LinkButton>
                        <LinkButton href="/admin/customers" variant="secondary" size="sm">
                          <Building2 className="w-4 h-4" />
                          Customers
                        </LinkButton>
                        <LinkButton href="/admin/reports" variant="secondary" size="sm">
                          <FileSpreadsheet className="w-4 h-4" />
                          Reports
                        </LinkButton>
                        <LinkButton href="/admin/insights" variant="secondary" size="sm">
                          <TrendingUp className="w-4 h-4" />
                          Insights
                        </LinkButton>
                      </div>
                    </>
                  )}

                  {showManage && (
                    <>
                      <p className={GROUP_LABEL}>Manage</p>
                      <div className="grid grid-cols-2 gap-2">
                        {role === "admin" && (
                          <>
                            <LinkButton href="/admin/users" variant="secondary" size="sm">
                              <Users className="w-4 h-4" />
                              Users
                            </LinkButton>
                            <LinkButton href="/admin/org" variant="secondary" size="sm">
                              <Building className="w-4 h-4" />
                              Org Settings
                            </LinkButton>
                          </>
                        )}
                        {showOfficeSurface && (
                          <LinkButton href="/admin/cost-codes" variant="secondary" size="sm">
                            <Tag className="w-4 h-4" />
                            Codes
                          </LinkButton>
                        )}
                        {MANAGEMENT.has(role) && (
                          <LinkButton href="/admin/subcontractors" variant="secondary" size="sm">
                            <Briefcase className="w-4 h-4" />
                            Subs
                          </LinkButton>
                        )}
                        {MANAGEMENT.has(role) && (
                          <LinkButton href="/admin/customers" variant="secondary" size="sm">
                            <Building2 className="w-4 h-4" />
                            Customers
                          </LinkButton>
                        )}
                      </div>
                    </>
                  )}

                  {showTrack && (
                    <>
                      <p className={GROUP_LABEL}>Track</p>
                      <div className="grid grid-cols-2 gap-2">
                        {showOfficeSurface || showSuper ? (
                          <>
                            <LinkButton href="/time" variant="secondary" size="sm">
                              <Clock className="w-4 h-4" />
                              Time
                            </LinkButton>
                            <LinkButton href="/photos" variant="secondary" size="sm">
                              <Images className="w-4 h-4" />
                              Photos
                            </LinkButton>
                            <LinkButton href="/calendar" variant="secondary" size="sm">
                              <Calendar className="w-4 h-4" />
                              Calendar
                            </LinkButton>
                          </>
                        ) : (
                          <LinkButton href="/calendar" variant="secondary" size="sm">
                            <Calendar className="w-4 h-4" />
                            Calendar
                          </LinkButton>
                        )}
                        {showOfficeSurface && (
                          <LinkButton href="/admin/reports" variant="secondary" size="sm">
                            <FileSpreadsheet className="w-4 h-4" />
                            Reports
                          </LinkButton>
                        )}
                      </div>
                    </>
                  )}
                </Card>

                {/* Notifications — office-like feed of customer actions
                    (estimate accepted/declined, invoice paid). RLS-scoped to
                    the caller's org. Renders its own titled white box, so no
                    Card wrapper. */}
                {showNotifications && (
                  <NotificationsFeed notifications={notifications} />
                )}

                <Card>
                  <CardHeader
                    title="Recent Photos"
                    action={
                      showOfficeSurface && photos && photos.length > 0 ? (
                        <LinkButton href="/photos" variant="secondary" size="sm">
                          View all
                        </LinkButton>
                      ) : undefined
                    }
                  />
                  {photos && photos.length > 0 ? (
                    <SignedPhotoGrid
                      photos={photos.map((p) => ({
                        id: p.id,
                        storage_path: p.storage_path,
                        caption: p.caption,
                      }))}
                    />
                  ) : (
                    <EmptyState
                      icon={EmptyIcons.Camera}
                      title="No photos yet"
                      description="Field photos uploaded by your crew will show up here."
                    />
                  )}
                </Card>
              </div>
            </div>
          </div>
        )}
      </ClientPullToRefresh>
    </PageContainer>
  );
}
