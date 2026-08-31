import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { OFFICE_LIKE, FIELD } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { describeShiftFlags, formatDuration } from "@/lib/shiftRules";
import { isLawn } from "@/lib/variant";
import PageContainer from "@/components/PageContainer";
import Link from "next/link";
import { Receipt, FileText, Calendar, ClipboardList, CheckSquare, FileDiff, FileSpreadsheet, Clock, TrendingUp, Bell, Images, Camera, Contact, Briefcase, Tag } from "lucide-react";

export default async function OfficePage() {
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const showReports = role === "office" || role === "admin";  // /admin/reports excludes super_admin

  const supabase = await createClient();

  // ── Who has not clocked in today ──────────────────────────────────────────
  // The only way a forgotten clock-in gets caught the same day: GPS exists
  // only while the clock runs, so the phone cannot report the absence — the
  // office must see the absence. Read once per page load; no polling.
  // "Today" is the server's local midnight (UTC on the host) — the same
  // convention the reports use.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [crewRes, todaysRes, lastRes] = await Promise.all([
    // Field roles only — the people the time clock exists for. Leads get
    // flagged missing here, not chased as managers.
    supabase.from("profiles").select("id, full_name, role").in("role", [...FIELD]),
    supabase
      .from("time_entries")
      .select("user_id")
      .gte("clock_in_at", todayStart.toISOString()),
    // Cheap last-seen date: one ordered page, first hit per user wins.
    supabase
      .from("time_entries")
      .select("user_id, clock_in_at")
      .order("clock_in_at", { ascending: false })
      .limit(500),
  ]);
  const clockedInToday = new Set(
    ((todaysRes.data ?? []) as { user_id: string }[]).map((r) => r.user_id)
  );
  const lastShiftByUser = new Map<string, string>();
  for (const r of (lastRes.data ?? []) as { user_id: string; clock_in_at: string }[]) {
    if (!lastShiftByUser.has(r.user_id)) lastShiftByUser.set(r.user_id, r.clock_in_at);
  }
  const notClockedIn = ((crewRes.data ?? []) as {
    id: string;
    full_name: string | null;
  }[])
    .filter((p) => !clockedInToday.has(p.id))
    .map((p) => ({
      name: p.full_name ?? "Unknown",
      last: lastShiftByUser.get(p.id) ?? null,
    }));

  // ── Shifts with no recorded property time ────────────────────────────────
  // The strongest payroll signal there is — hours clocked with zero on-site
  // stamps — and the noisiest, because the identical record is produced by a
  // dead phone, a route without map pins, or a day of shop work. So this is
  // a plain review list: neutral colours, no counter, wording that leads
  // with the innocent explanations. The RPC is already scoped to the
  // caller's org and takes nothing from the client. Lawn only — on-site
  // stamps are a lawn concept, so the section would be permanently empty
  // construction noise.
  const nameById = new Map<string, string>();
  for (const p of (crewRes.data ?? []) as { id: string; full_name: string | null }[]) {
    nameById.set(p.id, p.full_name ?? "Unknown");
  }
  type MissingOnSiteRow = {
    user_id?: string;
    name?: string | null;
    hours: number | string | null;
    crew_size: number | string | null;
    clock_in_backdated: boolean | null;
    auto_closed: boolean | null;
    clock_in_location_source: string | null;
  };
  const missingRaw = isLawn()
    ? await supabase.rpc("shifts_missing_on_site_time")
    : { data: [], error: null };
  const missingShifts = ((missingRaw.data ?? []) as MissingOnSiteRow[])
    .map((r) => ({
      who:
        r.name ??
        nameById.get(r.user_id ?? "") ??
        (r.user_id ? "Unknown" : "—"),
      hours: Number(r.hours ?? 0),
      crewSize: r.crew_size == null ? null : Number(r.crew_size),
      backdated: r.clock_in_backdated ?? false,
      autoClosed: r.auto_closed ?? false,
      source: r.clock_in_location_source ?? null,
    }))
    .sort((a, b) => b.hours - a.hours);

  return (
    <PageContainer title="Office" subtitle="Records, reports & schedule" maxWidth="list">
      {/* Not clocked in today — rendered only when someone is missing, so the
          hub stays quiet on the good days. This is the same-day catch the
          phone cannot do: without a running clock there is no location, so
          "not here yet" only exists as a list on this side. */}
      {notClockedIn.length > 0 && (
        <section className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
          <h2 className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            Not clocked in today ({notClockedIn.length})
          </h2>
          <p className="text-[11px] text-amber-800 mt-0.5">
            Field crew with no shift started today. Worth a call before the day
            is gone — there is no signal from the phone until the clock runs.
          </p>
          <ul className="mt-2 space-y-1">
            {notClockedIn.map((p) => (
              <li
                key={p.name}
                className="flex items-center justify-between gap-2 text-sm text-amber-900"
              >
                <span className="truncate">{p.name}</span>
                <span className="text-[11px] text-amber-700 flex-shrink-0">
                  {p.last
                    ? `Last shift ${new Date(p.last).toLocaleDateString([], { month: "short", day: "numeric" })}`
                    : "Never clocked in"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* ── Shifts with no recorded property time ──────────────────────────
          A review list, not a red flag: the identical record comes from a
          dead phone, a shop day, or a route without map pins as from
          anything dishonest. Neutral styling, no badge, no counter — this
          exists so the office can ASK the same day, not so it can count. */}
      {isLawn() && (
        <section className="mb-3 bg-white border border-gray-200 rounded-lg p-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Shifts with no recorded property time
          </h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Completed shifts of 2+ hours with no on-site stamp at any
            property. Often the simplest explanation — a dead phone, a route
            whose stops had no map pins, or a day of shop work. The office
            knows the crew; this is the list to start the conversation, not a
            verdict.
          </p>
          {(missingRaw.error) ? (
            <p className="text-[11px] text-gray-400 mt-2">
              Couldn&apos;t load this list.
            </p>
          ) : missingShifts.length === 0 ? (
            <p className="text-xs text-gray-400 mt-2">
              Nothing here — every shift long enough to count has at least
              one property stamp.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100">
              {missingShifts.map((r, i) => {
                // Same reduced-claim wording the crew page + weekly report use.
                const flags = describeShiftFlags({
                  backdated: r.backdated,
                  autoClosed: r.autoClosed,
                  crewSize: r.crewSize,
                });
                return (
                  <li
                    key={`${r.who}-${r.hours}-${i}`}
                    className="py-1.5 flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-gray-900 truncate">{r.who}</p>
                      <p className="text-[11px] text-gray-500">
                        {formatDuration(r.hours * 3_600_000)}
                        {flags.length > 0 && ` · ${flags.join(" · ")}`}
                      </p>
                    </div>
                    {/* Clock-in pin quality: a GPS fix is evidence; an IP
                        one can be wrong by miles, so it reads weaker — same
                        amber tint the shift card uses. */}
                    {r.source === "gps" ? (
                      <span className="text-[10px] text-gray-600 bg-gray-100 rounded px-1.5 py-0.5 flex-shrink-0">
                        GPS clock-in
                      </span>
                    ) : r.source === "ip" ? (
                      <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 flex-shrink-0">
                        Approximate clock-in
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-400 rounded px-1.5 py-0.5 flex-shrink-0">
                        No clock-in pin
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <div className="grid grid-cols-2 gap-2">
        {isLawn() ? (
          <>
            <Link href="/estimates" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <FileText className="w-5 h-5" />
              Estimates
            </Link>
            {/* Customers lives HERE, not on the Account hub. It is an
                operational entity, and Account is for your login, your people
                and your billing. It was previously only reachable from the
                Account (Manage) hub card — so when that card was removed,
                mobile lost its only route to Customers entirely: admins get
                just Home / Office / Account there, and Customers is not a tab. */}
            <Link href="/admin/customers" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Contact className="w-5 h-5" />
              Customers
            </Link>
            <Link href="/invoices" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Receipt className="w-5 h-5" />
              Invoices
            </Link>
            {showReports && (
              <Link href="/admin/reports" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
                <FileSpreadsheet className="w-5 h-5" />
                Reports
              </Link>
            )}
            <Link href="/calendar" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Calendar className="w-5 h-5" />
              Calendar
            </Link>
            {/* Photos (/crew/photo) — lawn has no Field hub (construction
                reaches it from Field), so the photo capture page lives on
                the Office hub for mobile. Matches the desktop sidebar, which
                already gives office/admin a Photos tab. */}
            <Link href="/crew/photo" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Camera className="w-5 h-5" />
              Photos
            </Link>
            {/* Customers lives on the Manage tab only — it was duplicated
                here too (Office AND Manage both linking to /admin/customers),
                which read as "two customer tabs doing the same thing." */}
            <Link href="/crew/time" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Clock className="w-5 h-5" />
              Clock in/out
            </Link>
            <Link href="/lawn/insights" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <TrendingUp className="w-5 h-5" />
              Insights
            </Link>
            <Link href="/lawn/notifications" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Bell className="w-5 h-5" />
              Notifications
            </Link>
          </>
        ) : (
          <>
            <Link href="/admin/customers" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Contact className="w-5 h-5" />
              Customers
            </Link>
            <Link href="/receipts" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Receipt className="w-5 h-5" />
              Receipts
            </Link>
            {/* Subcontractors + Cost Codes moved off the Account hub: they are
                construction business/config surfaces, not account concerns.
                Safe to move because /dashboard (construction's Home tab)
                already links both, so neither depends on this card for
                reachability — it is discoverability, not the only door. */}
            <Link href="/admin/subcontractors" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Briefcase className="w-5 h-5" />
              Subcontractors
            </Link>
            <Link href="/admin/cost-codes" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Tag className="w-5 h-5" />
              Cost Codes
            </Link>
            <Link href="/daily-logs" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <ClipboardList className="w-5 h-5" />
              Daily Logs
            </Link>
            <Link href="/punch" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <CheckSquare className="w-5 h-5" />
              Punch List
            </Link>
            <Link href="/change-orders" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <FileDiff className="w-5 h-5" />
              Change Orders
            </Link>
            <Link href="/submittals" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <FileText className="w-5 h-5" />
              Submittals
            </Link>
            {/* Global photo browser (/photos) — collects every job's photos
                in one place. It already existed but had no nav entry point
                anywhere in the app, so it was effectively unreachable. */}
            <Link href="/photos" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Images className="w-5 h-5" />
              Photos
            </Link>
            {showReports && (
              <Link href="/admin/reports" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
                <FileText className="w-5 h-5" />
                Reports
              </Link>
            )}
            <Link href="/calendar" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Calendar className="w-5 h-5" />
              Calendar
            </Link>
          </>
        )}
      </div>
    </PageContainer>
  );
}