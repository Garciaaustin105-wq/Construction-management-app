import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import { getMe } from "@/lib/tenant";
import {
  Building,
  Sprout,
  Users,
  Activity,
  TrendingUp,
  CircleDollarSign,
  Webhook,
} from "lucide-react";

// Developer / platform-ops console — super_admin only. The owner runs the app
// as the sole developer; this surfaces what they can't see without digging into
// Vercel/Supabase logs: tenant growth, plan/MRR distribution, variant split,
// per-tenant health (last activity = churn signal), and the Stripe-webhook
// audit feed. All derived from existing tables — no new SQL, no event
// instrumentation. Uses the RLS SESSION client (not the service role):
// same_org() short-circuits true for super_admin, so the session reads across
// every org with no policy change and no secret in the page.

type Org = {
  id: string;
  name: string;
  app_variant: string | null;
  plan: string | null;
  plan_status: string | null;
  subscription_amount_cents: number | null;
  created_at: string;
};

function fmtMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const mo = Math.floor(days / 30);
  return mo === 1 ? "1 month ago" : `${mo} months ago`;
}

const STATUS_STYLE: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trial: "bg-blue-100 text-blue-700",
  past_due: "bg-amber-100 text-amber-700",
  canceled: "bg-gray-100 text-gray-500",
  expired: "bg-red-100 text-red-700",
};

export default async function DevPanelPage() {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) redirect("/login");
  if (!tenant.isSuperAdmin) redirect("/dashboard");

  const [orgsRes, profilesRes, jobsRes, invoicesRes, timesRes, eventsRes] =
    await Promise.all([
      supabase
        .from("organizations")
        .select(
          "id, name, app_variant, plan, plan_status, subscription_amount_cents, created_at"
        ),
      supabase.from("profiles").select("organization_id"),
      supabase.from("jobs").select("organization_id, created_at"),
      supabase.from("invoices").select("organization_id, created_at"),
      supabase.from("time_entries").select("organization_id, created_at"),
      supabase
        .from("billing_events")
        .select("id, event_type, created_at, organization_id")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  const orgs = (orgsRes.data ?? []) as Org[];

  // Member counts per org.
  const memberCounts = new Map<string, number>();
  for (const p of (profilesRes.data ?? []) as {
    organization_id: string | null;
  }[]) {
    if (p.organization_id) {
      memberCounts.set(
        p.organization_id,
        (memberCounts.get(p.organization_id) ?? 0) + 1
      );
    }
  }

  // Last activity per org + job/invoice row counts. Last activity = the most
  // recent created_at across jobs/invoices/time_entries for that org (no
  // last_activity column exists, so derive it). ISO strings compare lexically.
  const lastActivity = new Map<string, string>();
  const jobsByOrg = new Map<string, number>();
  const invoicesByOrg = new Map<string, number>();
  const bump = (orgId: string | null, ts: string | null) => {
    if (!orgId || !ts) return;
    const cur = lastActivity.get(orgId);
    if (!cur || ts > cur) lastActivity.set(orgId, ts);
  };
  const countJob = (orgId: string | null) => {
    if (orgId) jobsByOrg.set(orgId, (jobsByOrg.get(orgId) ?? 0) + 1);
  };
  const countInv = (orgId: string | null) => {
    if (orgId) invoicesByOrg.set(orgId, (invoicesByOrg.get(orgId) ?? 0) + 1);
  };
  for (const j of (jobsRes.data ?? []) as {
    organization_id: string | null;
    created_at: string | null;
  }[]) {
    countJob(j.organization_id);
    bump(j.organization_id, j.created_at);
  }
  for (const inv of (invoicesRes.data ?? []) as {
    organization_id: string | null;
    created_at: string | null;
  }[]) {
    countInv(inv.organization_id);
    bump(inv.organization_id, inv.created_at);
  }
  for (const t of (timesRes.data ?? []) as {
    organization_id: string | null;
    created_at: string | null;
  }[]) {
    bump(t.organization_id, t.created_at);
  }

  // Platform MRR (subscription_amount_cents is synced from Stripe by the
  // webhook, so no Stripe API call).
  const mrrCents = orgs.reduce(
    (s, o) =>
      o.plan_status === "active" ? s + (o.subscription_amount_cents ?? 0) : s,
    0
  );
  const activeCount = orgs.filter((o) => o.plan_status === "active").length;
  const trialCount = orgs.filter((o) => o.plan_status === "trial").length;
  const variantCounts = {
    construction: orgs.filter((o) => o.app_variant !== "lawn").length,
    lawn: orgs.filter((o) => o.app_variant === "lawn").length,
  };

  // Plan + status distribution.
  const planCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  for (const o of orgs) {
    planCounts.set(o.plan ?? "none", (planCounts.get(o.plan ?? "none") ?? 0) + 1);
    statusCounts.set(
      o.plan_status ?? "none",
      (statusCounts.get(o.plan_status ?? "none") ?? 0) + 1
    );
  }

  // Tenant growth — last 12 months bucketed by organizations.created_at.
  // Async server component — runs once per request, so Date.now() is the
  // request time, not a client side effect. react-hooks/purity is a false
  // positive here (same justification as /time).
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const months: { key: string; label: string; count: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    d.setDate(1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push({ key, label: d.toLocaleDateString([], { month: "short" }), count: 0 });
  }
  const monthIdx = new Map(months.map((m, i) => [m.key, i]));
  for (const o of orgs) {
    const idx = monthIdx.get(o.created_at.slice(0, 7));
    if (idx !== undefined) months[idx].count++;
  }
  const maxMonth = Math.max(1, ...months.map((m) => m.count));

  const events = (eventsRes.data ?? []) as {
    id: string;
    event_type: string;
    created_at: string;
    organization_id: string | null;
  }[];
  const orgNameById = new Map(orgs.map((o) => [o.id, o.name]));

  // Health table sorted by last activity desc (stalest tenants surface last).
  const health = [...orgs].sort((a, b) => {
    const la = lastActivity.get(a.id) ?? "";
    const lb = lastActivity.get(b.id) ?? "";
    return lb < la ? -1 : lb > la ? 1 : 0;
  });

  return (
    <PageContainer title="Dev" subtitle={`${orgs.length} org${orgs.length === 1 ? "" : "s"} · ${fmtMoney(mrrCents)}/mo`} maxWidth="list">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatTile icon={Building} label="Organizations" value={String(orgs.length)} />
        <StatTile icon={CircleDollarSign} label="Platform MRR" value={fmtMoney(mrrCents)} />
        <StatTile icon={TrendingUp} label="Active subs" value={String(activeCount)} />
        <StatTile icon={Activity} label="Trials" value={String(trialCount)} />
      </div>

      {/* Tenant growth — 12-month bar list */}
      <section className="bg-white rounded-lg shadow-sm p-4">
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-3 flex items-center gap-1">
          <TrendingUp className="w-4 h-4" />
          Tenant Growth · last 12 months
        </h2>
        <div className="flex items-end gap-1 h-28">
          {months.map((m) => (
            <div key={m.key} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              <span className="text-[10px] font-mono text-gray-700 tabular-nums">
                {m.count || ""}
              </span>
              <div
                className="w-full bg-blue-500 rounded-t"
                style={{ height: `${(m.count / maxMonth) * 100}%`, minHeight: m.count ? "4px" : "0" }}
                title={`${m.label}: ${m.count}`}
              />
              <span className="text-[10px] text-gray-400 truncate w-full text-center">
                {m.label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Distribution + variant split */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        <DistCard title="Plan">
          {[...planCounts.entries()].map(([k, n]) => (
            <DistRow key={k} label={k} n={n} total={orgs.length} />
          ))}
        </DistCard>
        <DistCard title="Plan status">
          {[...statusCounts.entries()].map(([k, n]) => (
            <DistRow key={k} label={k} n={n} total={orgs.length} />
          ))}
        </DistCard>
        <DistCard title="Variant">
          <DistRow label="construction" n={variantCounts.construction} total={orgs.length} />
          <DistRow label="lawn" n={variantCounts.lawn} total={orgs.length} />
        </DistCard>
      </div>

      {/* Tenant health table */}
      <section className="bg-white rounded-lg shadow-sm overflow-hidden">
        <h2 className="text-sm font-semibold text-gray-500 uppercase p-4 pb-2 flex items-center gap-1">
          <Building className="w-4 h-4" />
          Tenant Health
        </h2>
        {health.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">No organizations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Org</th>
                  <th className="text-left font-medium px-3 py-2">Variant</th>
                  <th className="text-left font-medium px-3 py-2">Plan</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-right font-medium px-3 py-2">Members</th>
                  <th className="text-right font-medium px-3 py-2">Jobs</th>
                  <th className="text-right font-medium px-3 py-2">Invoices</th>
                  <th className="text-left font-medium px-3 py-2">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {health.map((o) => {
                  const last = lastActivity.get(o.id);
                  const stale = !last || now - new Date(last).getTime() > 30 * 86_400_000;
                  return (
                    <tr key={o.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-900 truncate max-w-[180px]">
                        {o.name}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 ${o.app_variant === "lawn" ? "text-green-700" : "text-gray-600"}`}>
                          {o.app_variant === "lawn" ? <Sprout className="w-3 h-3" /> : <Building className="w-3 h-3" />}
                          {o.app_variant ?? "construction"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600 capitalize">{o.plan ?? "—"}</td>
                      <td className="px-3 py-2">
                        {o.plan_status ? (
                          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_STYLE[o.plan_status] ?? "bg-gray-100 text-gray-600"}`}>
                            {o.plan_status}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-700">
                        <Users className="w-3 h-3 inline mr-0.5 text-gray-400" />
                        {memberCounts.get(o.id) ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-700">
                        {jobsByOrg.get(o.id) ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-700">
                        {invoicesByOrg.get(o.id) ?? 0}
                      </td>
                      <td className={`px-3 py-2 ${stale ? "text-amber-700 font-medium" : "text-gray-600"}`}>
                        {relativeDays(last)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* System events — Stripe webhook audit */}
      <section className="bg-white rounded-lg shadow-sm p-4">
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-3 flex items-center gap-1">
          <Webhook className="w-4 h-4" />
          System Events · recent billing webhooks
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">No webhook events recorded.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {events.map((e) => (
              <li key={e.id} className="py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {e.event_type}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {orgNameById.get(e.organization_id ?? "") ?? "—"}
                  </p>
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {new Date(e.created_at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Building;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-white rounded-lg p-3 shadow-sm">
      <Icon className="w-4 h-4 text-gray-400" />
      <p className="text-xl font-bold text-gray-900 mt-1">{value}</p>
      <p className="text-[10px] uppercase font-semibold text-gray-500">{label}</p>
    </div>
  );
}

function DistCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">{title}</h2>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function DistRow({
  label,
  n,
  total,
}: {
  label: string;
  n: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-700 capitalize">{label}</span>
      <span className="text-gray-500 font-mono tabular-nums">
        {n} <span className="text-gray-400">· {pct}%</span>
      </span>
    </div>
  );
}