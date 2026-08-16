import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";
import { formatMoney, computeTotal } from "@/lib/money";
import SignedPhotoGrid from "@/components/SignedPhotoGrid";
import Link from "next/link";
import { Plus, Receipt, Clock, Tag, Calculator, Images, Briefcase, Building2, FileSpreadsheet, Users, Building, Calendar, Sprout } from "lucide-react";
import { MANAGEMENT, isSuperAdmin } from "@/lib/roles";
import PlanBanner from "@/components/PlanBanner";
import NotificationsFeed from "@/components/NotificationsFeed";

// Small overline label that groups the dashboard tiles into named sections
// (Create / Manage / Track / Your Work). Kept deliberately understated so it
// reads as a section divider, not a heading that competes with content titles.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">
      {children}
    </h2>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .maybeSingle();

  // No profile row means the auth user exists but no workspace was created
  // (e.g. a signup that didn't persist the profile, or a dashboard-created
  // auth user with no profile). Don't silently drop them into a crew view that
  // looks like a successful login to the wrong project — surface the broken
  // state so it gets fixed. ("Users read own profile" is just id = auth.uid(),
  // so a null result reliably means no profile, not an RLS hiccup.)
  if (!profile) {
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

  const role = profile.role ?? "crew";

  // Show the user's OWN organization name (not a hardcoded brand) so each
  // tenant sees their own workspace — otherwise every new business is labelled
  // "Terra Vista" and appears to be someone else's project. "Org members read
  // org" admits same_org, so a user with a profile can read their own org;
  // super_admin has org_id null and lands on the platform view instead.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.organization_id)
    .maybeSingle();
  const orgName = orgRow?.name ?? "Workspace";

  // admin supersetes office on the office surface (grid, weekly report,
  // invoices, RFIs). super_admin does NOT get the office surface — they get a
  // platform view instead (they have no org, so the office grid would query
  // across all orgs).
  const showOfficeSurface = role === "office" || role === "admin";
  const showPlatform = isSuperAdmin(role);
  // Section visibility — each tile inside still keeps its own exact role guard;
  // these only decide whether a labeled section renders at all.
  const showCreate = showOfficeSurface || role === "project_manager";
  const showManage = MANAGEMENT.has(role);
  const showTrack = showOfficeSurface || !showPlatform;
  // Office-like (office/admin/super_admin) see the customer-action feed
  // (estimate accepted/declined, invoice paid). RLS (tier_office) scopes the
  // query to the caller's org (super_admin sees the platform-wide feed).
  const showNotifications = showOfficeSurface || showPlatform;

  // Fan out the independent reads in parallel (was sequential awaits, so the
  // dashboard waited on jobs → photos → rfis → invoices one after another).
  const [jobsRes, photosRes, rfisRes, invoicesRes, notificationsRes] =
    await Promise.all([
      supabase
        .from("jobs")
        .select("id, name, status, customers(name)")
        .eq("type", "construction")
        .order("created_at", { ascending: false }),
      supabase
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
    ]);

  const jobs = jobsRes.data;
  const photos = photosRes.data;
  const rfis = rfisRes.data;
  const unpaidInvoices = invoicesRes.data;
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title={orgName} subtitle={`Signed in as ${role}`} />

      <main className="max-w-md lg:max-w-7xl mx-auto p-4 space-y-6">
        <PlanBanner />
        <ClientPullToRefresh>
        {/* Super admin: platform view (no org, so no office grid). */}
        {showPlatform && (
          <div className="space-y-2">
            <Link
              href="/admin/orgs"
              className="block bg-blue-600 text-white text-center py-4 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
            >
              <Building className="w-5 h-5" />
              Platform · All Organizations
            </Link>
            <Link
              href="/admin/users"
              className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
            >
              <Users className="w-5 h-5" />
              Users
            </Link>
          </div>
        )}

        {/* CREATE — office/admin quick actions, or the PM invoice grid. PM is
            not on the office surface, so it gets its own two-tile grid here. */}
        {showCreate && (
          <section className="space-y-2">
            <SectionHeader>Create</SectionHeader>
            {showOfficeSurface && (
              <div className="grid grid-cols-3 gap-2">
                <Link
                  href="/admin/projects/new"
                  className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
                >
                  <Plus className="w-5 h-5" />
                  New
                </Link>
                <Link
                  href="/estimates"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Calculator className="w-5 h-5" />
                  Estimates
                </Link>
                <Link
                  href="/invoices/new"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Receipt className="w-5 h-5" />
                  Invoice
                </Link>
              </div>
            )}
            {role === "project_manager" && (
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href="/invoices/new"
                  className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
                >
                  <Receipt className="w-5 h-5" />
                  Invoice
                </Link>
                <Link
                  href="/invoices"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Receipt className="w-5 h-5" />
                  All Invoices
                </Link>
              </div>
            )}
          </section>
        )}

        {/* MANAGE — admin (users + org settings) + MANAGEMENT (cost codes,
            subs, customers). Each tile keeps its own role guard. */}
        {showManage && (
          <section className="space-y-2">
            <SectionHeader>Manage</SectionHeader>
            {role === "admin" && (
              <div className="grid grid-cols-2 gap-2">
                <Link
                  href="/admin/users"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Users className="w-5 h-5" />
                  Users
                </Link>
                <Link
                  href="/admin/org"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Building className="w-5 h-5" />
                  Org Settings
                </Link>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {showOfficeSurface && (
                <Link
                  href="/admin/cost-codes"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Tag className="w-5 h-5" />
                  Codes
                </Link>
              )}
              {showOfficeSurface && (
                <Link
                  href="/lawn"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Sprout className="w-5 h-5 text-green-600" />
                  Lawn
                </Link>
              )}
              {MANAGEMENT.has(role) && (
                <Link
                  href="/admin/subcontractors"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Briefcase className="w-5 h-5" />
                  Subs
                </Link>
              )}
              {MANAGEMENT.has(role) && (
                <Link
                  href="/admin/customers"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Building2 className="w-5 h-5" />
                  Customers
                </Link>
              )}
            </div>
          </section>
        )}

        {/* TRACK — time/photos/reports (office) + calendar (every org user
            except super_admin). Office gets the grid; everyone else just gets
            the full-width calendar link. */}
        {showTrack && (
          <section className="space-y-2">
            <SectionHeader>Track</SectionHeader>
            {showOfficeSurface ? (
              <div className="grid grid-cols-3 gap-2">
                <Link
                  href="/time"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Clock className="w-5 h-5" />
                  Time
                </Link>
                <Link
                  href="/photos"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Images className="w-5 h-5" />
                  Photos
                </Link>
                <Link
                  href="/calendar"
                  className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
                >
                  <Calendar className="w-5 h-5" />
                  Calendar
                </Link>
              </div>
            ) : (
              <Link
                href="/calendar"
                className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <Calendar className="w-5 h-5" />
                Calendar
              </Link>
            )}
            {showOfficeSurface && (
              <Link
                href="/admin/reports"
                className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2"
              >
                <FileSpreadsheet className="w-5 h-5" />
                Reports
              </Link>
            )}
          </section>
        )}

        {/* YOUR WORK — jobs, photos, invoices, RFIs. Each subsection keeps its
            own role guard; this header just labels the group. */}
        <SectionHeader>Your Work</SectionHeader>
        {/* Desktop: 2-col (3-col on xl) grid so the four work sections read as a
            dashboard, not a phone feed. Mobile keeps the vertical space-y-6
            stack in the exact same DOM order (Jobs, Photos, Invoices, RFIs).
            lg:items-start stops shorter cards from stretching to match a tall
            neighbor. */}
        <div className="space-y-6 lg:grid lg:grid-cols-2 lg:gap-6 lg:space-y-0 lg:items-start xl:grid-cols-3">

        {/* Notifications — office-like feed of customer actions (estimate
            accepted/declined, invoice paid). RLS-scoped to the caller's org. */}
        {showNotifications && (
          <section>
            <NotificationsFeed notifications={notifications} />
          </section>
        )}

        {/* Jobs as cards — tap to view detail */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
            Your Jobs
          </h2>
          <div className="space-y-2">
            {jobs?.map((job) => (
              <Link
                key={job.id}
                href={`/jobs/${job.id}`}
                className="block bg-white rounded-lg p-4 shadow-sm active:bg-gray-50"
              >
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {job.name}
                    </p>
                    <p className="text-sm text-gray-500 truncate">
                      {(job.customers as unknown as { name: string } | null)?.name ?? "—"}
                    </p>
                  </div>
                  <StatusBadge status={job.status} />
                </div>
              </Link>
            ))}
            {(!jobs || jobs.length === 0) && (
              <div className="bg-white rounded-lg">
                <EmptyState
                  icon={EmptyIcons.Briefcase}
                  title="No jobs yet"
                  description={
                    showOfficeSurface
                      ? "Tap “New Project” above to create your first job."
                      : "Your assigned jobs will show up here once the office assigns them."
                  }
                />
              </div>
            )}
          </div>
        </section>

        {/* Recent photos as thumbnails */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase">
              Recent Photos
            </h2>
            {showOfficeSurface && photos && photos.length > 0 && (
              <Link href="/photos" className="text-xs text-blue-600 font-medium">
                View all
              </Link>
            )}
          </div>
          {photos && photos.length > 0 ? (
            <SignedPhotoGrid
              photos={photos.map((p) => ({
                id: p.id,
                storage_path: p.storage_path,
                caption: p.caption,
              }))}
            />
          ) : (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Camera}
                title="No photos yet"
                description="Field photos uploaded by your crew will show up here."
              />
            </div>
          )}
        </section>

        {/* Unpaid invoices — office / admin */}
        {showOfficeSurface && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase flex items-center gap-1">
                <Receipt className="w-4 h-4" />
                Unpaid Invoices
              </h2>
              <Link
                href="/invoices?status=sent"
                className="text-xs text-blue-600 font-medium"
              >
                View all
              </Link>
            </div>
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
                <div className="space-y-2">
                  {unpaidRows.map((inv) => (
                    <Link
                      key={inv.id}
                      href={`/invoices/${inv.id}`}
                      className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
                    >
                      <div className="flex justify-between items-start gap-2">
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
                      </div>
                    </Link>
                  ))}
                </div>
              </>
            ) : (
              <div className="bg-white rounded-lg">
                <EmptyState
                  icon={EmptyIcons.FileText}
                  title="All paid up"
                  description="No outstanding invoices right now."
                />
              </div>
            )}
          </section>
        )}

        {/* RFIs — shown to office / admin */}
        {showOfficeSurface && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
              Recent RFIs
            </h2>
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {rfis?.map((r) => (
                <div key={r.id} className="p-3">
                  <p className="text-sm text-gray-900">{r.question}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {(r.jobs as unknown as { name: string } | null)?.name ?? "—"} ·{" "}
                    <span className="font-medium">{r.status}</span>
                  </p>
                </div>
              ))}
              {(!rfis || rfis.length === 0) && (
                <EmptyState
                  icon={EmptyIcons.Inbox}
                  title="No RFIs yet"
                  description="Submitted RFIs from your crew will appear here."
                />
              )}
            </div>
          </section>
        )}
        </div>
        </ClientPullToRefresh>
      </main>

    </div>
  );
}