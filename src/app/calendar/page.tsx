import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import TopBar from "@/components/TopBar";
import CalendarFeedCard from "./CalendarFeedCard";
import { getMyOrg } from "@/lib/tenant";

// Personal calendar subscribe settings. Any signed-in user may have a personal
// iCal feed; the feed itself enforces role-based content (crew/customer get no
// subcontractor or financial info beyond their own). super_admin without an org
// has nothing personal to subscribe to — they get a notice instead.
export default async function CalendarPage() {
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
  const host =
    h.get("x-forwarded-host") || h.get("host") || "localhost";
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const origin = `${scheme}://${host}`;

  // super_admin with no org: no personal feed (requireOrgScoped on the token
  // route would 403). Show a notice rather than a broken card.
  if (!tenant.orgId) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24">
        <TopBar title="Calendar" subtitle="Subscribe feed" />
        <main className="max-w-md mx-auto p-4">
          <div className="bg-white rounded-lg p-4 shadow-sm text-sm text-gray-600">
            Platform (super admin) accounts don&rsquo;t have a personal calendar
            feed. Sign in under an organization to subscribe.
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Calendar" subtitle="Subscribe feed" />
      <main className="max-w-md mx-auto p-4 space-y-4">
        <CalendarFeedCard
          initialUrl={initialUrl}
          role={tenant.role}
          lastFetchedAt={feed?.last_fetched_at ?? null}
        />

        {/* Provider instructions */}
        <section className="bg-white rounded-lg p-4 shadow-sm space-y-3 text-sm text-gray-700">
          <h2 className="font-semibold text-gray-900">
            Add to your calendar
          </h2>
          <p className="text-xs text-gray-500">
            Copy the feed URL above, then add it to your calendar once. The feed
            is read-only — changes made in the app appear on the next sync.
            (Google + Outlook can&rsquo;t add a URL from their phone apps — add
            it on the web once and it syncs to your phone automatically.)
          </p>
          <div className="space-y-2">
            <div>
              <p className="font-medium text-gray-900">Google Calendar</p>
              <p className="text-xs text-gray-600">
                On a web browser, open calendar.google.com → ⚙️ Settings → Add
                calendar → From URL → paste → Add. It then appears in the
                Google Calendar app on your phone.
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-900">Outlook</p>
              <p className="text-xs text-gray-600">
                On the web at outlook.live.com → Add calendar → Subscribe from
                web → paste → Import. Syncs to the Outlook app.
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-900">Apple Calendar (iPhone)</p>
              <p className="text-xs text-gray-600">
                On the phone: Settings → Calendar → Accounts → Add Account →
                Other → Add Subscribed Calendar → paste URL → Subscribe.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}