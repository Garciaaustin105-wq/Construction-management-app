import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import CalendarFeedCard from "./CalendarFeedCard";
import MonthGrid from "./MonthGrid";
import AgendaList from "./AgendaList";
import { getMyOrg } from "@/lib/tenant";
import { getCalendarEvents } from "@/lib/calendarEvents";

// In-app calendar: a month grid + agenda list of this org's events (job
// start/end, schedule events, subcontractor dates, invoice due, estimate
// expiry, lawn visits), queried with the RLS session client so org + role
// visibility are enforced by RLS (no manual filters). The personal iCal
// subscribe feed card + provider instructions stay below as a secondary
// "sync to your phone" section.
//
// Tabs (Month / Agenda) are URL-driven (`?view=month|agenda`, `?month=YYYY-MM`)
// so the page stays a server component — no client JS — matching the codebase's
// filter pattern (e.g. ReceiptReportFilters) and the lawn calendar's <Link>
// month nav.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const sp = await searchParams;
  const view = sp.view === "agenda" ? "agenda" : "month";
  const month = sp.month ?? "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenant = await getMyOrg(supabase);
  if (!tenant) redirect("/login");

  // Build the public feed URL host from the incoming request so it works in
  // preview deploys + production without an env var.
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const origin = `${scheme}://${host}`;

  // super_admin with no org: no personal feed + no org-scoped events (RLS
  // same_org bypass would surface every org). Show a notice instead.
  if (!tenant.orgId) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
        <TopBar title="Calendar" subtitle="Events" />
        <main className="max-w-md lg:max-w-5xl mx-auto p-4">
          <div className="bg-white rounded-lg p-4 shadow-sm text-sm text-gray-600">
            Platform (super admin) accounts don&rsquo;t have an organization
            calendar. Sign in under an organization to see its events.
          </div>
        </main>
      </div>
    );
  }

  // Read the caller's existing feed row (RLS allows reading own row). If none,
  // the client card creates one on mount via POST /api/calendar/token.
  const { data: feed } = await supabase
    .from("calendar_feeds")
    .select("token, last_fetched_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const initialUrl = feed?.token
    ? `${origin}/api/calendar/feed?token=${feed.token}`
    : null;

  // All event sources, RLS-scoped to this org + role. Variant-aware (lawn_visits
  // only in the lawn variant). Independent of SUPABASE_SERVICE_ROLE_KEY — uses
  // the session (anon) key.
  const events = await getCalendarEvents(supabase);

  const monthHref = `/calendar?view=month${month ? `&month=${month}` : ""}`;
  const agendaHref = "/calendar?view=agenda";

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Calendar" subtitle="Events" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        {/* View tabs (URL-driven, no client JS) */}
        <div className="flex gap-2">
          <Link
            href={monthHref}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${
              view === "month"
                ? "bg-brand text-white"
                : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            Month
          </Link>
          <Link
            href={agendaHref}
            className={`px-4 py-2 rounded-lg text-sm font-semibold ${
              view === "agenda"
                ? "bg-brand text-white"
                : "bg-white text-gray-700 border border-gray-200"
            }`}
          >
            Agenda
          </Link>
        </div>

        {view === "month" ? (
          <MonthGrid events={events} month={month} />
        ) : (
          <AgendaList events={events} />
        )}

        {/* Sync to your phone — the personal iCal subscribe feed (secondary) */}
        <section className="space-y-3 pt-2">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">
            Sync to your phone
          </h2>
          <CalendarFeedCard
            initialUrl={initialUrl}
            role={tenant.role}
            lastFetchedAt={feed?.last_fetched_at ?? null}
          />

          {/* Provider instructions */}
          <div className="bg-white rounded-lg p-4 shadow-sm space-y-3 text-sm text-gray-700">
            <p className="text-xs text-gray-500">
              Copy the feed URL above, then add it to your calendar once. The
              feed is read-only — changes made in the app appear on the next
              sync. (Google + Outlook can&rsquo;t add a URL from their phone
              apps — add it on the web once and it syncs to your phone
              automatically.)
            </p>
            <div className="space-y-2">
              <div>
                <p className="font-medium text-gray-900">Google Calendar</p>
                <p className="text-xs text-gray-600">
                  On a web browser, open calendar.google.com → ⚙️ Settings →
                  Add calendar → From URL → paste → Add. It then appears in the
                  Google Calendar app on your phone.
                </p>
              </div>
              <div>
                <p className="font-medium text-gray-900">Outlook</p>
                <p className="text-xs text-gray-600">
                  On the web at outlook.live.com → Add calendar → Subscribe
                  from web → paste → Import. Syncs to the Outlook app.
                </p>
              </div>
              <div>
                <p className="font-medium text-gray-900">
                  Apple Calendar (iPhone)
                </p>
                <p className="text-xs text-gray-600">
                  On the phone: Settings → Calendar → Accounts → Add Account →
                  Other → Add Subscribed Calendar → paste URL → Subscribe.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}