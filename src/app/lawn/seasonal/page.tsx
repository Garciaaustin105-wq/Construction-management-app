import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import SeasonalActions from "@/components/SeasonalActions";
import { OFFICE_OR_PM } from "@/lib/roles";
import { Snowflake } from "lucide-react";

// /lawn/seasonal — customer-scoped seasonal pause/restart. Lists every
// customer in this org that has at least one recurring schedule, with a
// per-customer status (Active / Paused for winter / Mixed) and the
// Pause-for-off-season + Reopen actions (client component per row).
//
// Gate: OFFICE_OR_PM (office / admin / project_manager / super_admin). RLS
// scopes every read to the caller's org. Beats Jobber's per-job "hold":
// one tap pauses or reopens a whole account.

type SchedRow = {
  id: string;
  active: boolean;
  paused_from: string | null;
  paused_until: string | null;
  jobs: {
    customer_id: string | null;
    customers: { name: string | null } | null;
  } | null;
};

type CustomerGroup = {
  id: string;
  name: string;
  activeCount: number;
  pausedCount: number;
  pausedUntil: string | null;
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function SeasonalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  if (!OFFICE_OR_PM.has(role as never)) redirect("/dashboard");

  // Every recurring schedule in the org, with its job's customer. Grouped in
  // JS by customer_id so we get per-customer active/paused counts in one
  // query (no RPC). Schedules whose job has no customer are skipped — a
  // schedule needs a customer to pause "by customer."
  const { data: schedRows } = await supabase
    .from("recurring_schedules")
    .select("id, active, paused_from, paused_until, jobs(customer_id, customers(name))")
    .order("created_at", { ascending: false });
  const rows = (schedRows as unknown as SchedRow[] | null) ?? [];

  const byCustomer = new Map<string, CustomerGroup>();
  for (const s of rows) {
    const cid = s.jobs?.customer_id ?? null;
    if (!cid) continue;
    const name = s.jobs?.customers?.name ?? "Unknown customer";
    const g = byCustomer.get(cid);
    if (g) {
      if (s.active) g.activeCount += 1;
      else {
        g.pausedCount += 1;
        // Track the latest auto-resume date across the customer's paused
        // schedules (bulk-pause sets the same window on all of them, so this
        // is usually one value).
        if (s.paused_until && (!g.pausedUntil || s.paused_until > g.pausedUntil))
          g.pausedUntil = s.paused_until;
      }
    } else {
      byCustomer.set(cid, {
        id: cid,
        name,
        activeCount: s.active ? 1 : 0,
        pausedCount: s.active ? 0 : 1,
        pausedUntil: s.active ? null : s.paused_until,
      });
    }
  }

  // Paused-for-winter sorts first (the actionable state), then mixed, then
  // active — the office lands on what needs reopening.
  const customers = [...byCustomer.values()].sort((a, b) => {
    const rank = (g: CustomerGroup) =>
      g.pausedCount > 0 && g.activeCount === 0 ? 0 : g.pausedCount > 0 ? 1 : 2;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.name.localeCompare(b.name);
  });

  const today = todayISO();

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title="Seasonal"
        subtitle="Pause or reopen a customer's routes for the off-season"
        backHref="/lawn"
      />

      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        {customers.length === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={Snowflake}
              title="No recurring schedules"
              description="Customers with a recurring lawn schedule appear here so you can pause them for winter and reopen in spring."
            />
          </div>
        ) : (
          customers.map((c) => {
            const total = c.activeCount + c.pausedCount;
            const status =
              c.pausedCount === 0
                ? { label: "Active", chip: "bg-green-100 text-green-700" }
                : c.activeCount === 0
                  ? {
                      label: "Paused for winter",
                      chip: "bg-blue-100 text-blue-700",
                    }
                  : { label: "Mixed", chip: "bg-amber-100 text-amber-800" };
            return (
              <div
                key={c.id}
                className="bg-white rounded-lg p-4 shadow-sm space-y-3"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">
                      {c.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {c.activeCount} active · {c.pausedCount} paused · {total}{" "}
                      total
                    </p>
                    {c.pausedCount > 0 && c.pausedUntil && (
                      <p className="text-xs text-blue-600 font-medium">
                        Auto-resumes {c.pausedUntil}
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-[10px] font-semibold px-2 py-1 rounded whitespace-nowrap ${status.chip}`}
                  >
                    {status.label}
                  </span>
                </div>

                {/* Per-customer pause/reopen. min pause date defaults to today
                    (you can't pause the past); reopen starts the service
                    window fresh. */}
                <SeasonalActions
                  customerId={c.id}
                  customerName={c.name}
                  activeCount={c.activeCount}
                  pausedCount={c.pausedCount}
                  pausedUntil={c.pausedUntil}
                  today={today}
                />
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}