import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Building, Users as UsersIcon, ArrowRight } from "lucide-react";
import { getMe } from "@/lib/tenant";
import PageContainer from "@/components/PageContainer";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import ListToolbar, { type ViewMode } from "@/components/ui/ListToolbar";
import DataTable, { type Column } from "@/components/ui/DataTable";

type OrgRow = {
  id: string;
  name: string;
  email: string | null;
  plan: string | null;
  plan_status: string | null;
  trial_ends_at: string | null;
  subscription_amount_cents: number | null;
  created_at: string;
};

// Plan status → badge tone. Platform-specific (an org's billing state is not
// an estimate/invoice/job status), so the map lives with the page that uses it.
const PLAN_STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  past_due: "warning",
};

// Cards only — the Cards/Table switcher was a no-op (table just rendered the
// same rows as plain line items). Single-element MODES hides the ListToolbar
// switcher and forces `view` to always be "cards".
const MODES: ViewMode[] = ["cards"];

// Platform view — super_admin only. Lists every organization with a member
// count and a link to edit that org's business info. Any non-super_admin is
// bounced to the dashboard.
export default async function OrgsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant || !tenant.isSuperAdmin) redirect("/dashboard");

  const sp = await searchParams;
  const rawView = sp.view as ViewMode | undefined;
  const view: ViewMode = rawView && MODES.includes(rawView) ? rawView : "cards";

  const { data: orgs } = await supabase
    .from("organizations")
    .select(
      "id, name, email, plan, plan_status, trial_ends_at, subscription_amount_cents, created_at"
    )
    .order("created_at", { ascending: false });

  // Member count per org (one round-trip via a grouped count is not supported
  // on the Postgrest single-resource path without an RPC, so fetch all
  // profiles and count client-side of the DB — fine for a platform overview).
  const { data: profileCounts } = await supabase
    .from("profiles")
    .select("organization_id");

  const counts = new Map<string, number>();
  for (const p of profileCounts ?? []) {
    if (p.organization_id) {
      counts.set(p.organization_id, (counts.get(p.organization_id) ?? 0) + 1);
    }
  }

  const list = (orgs ?? []) as OrgRow[];

  // Platform MRR: sum of active subscriptions' monthly amount.
  const mrrCents = list.reduce(
    (sum, o) =>
      o.plan_status === "active"
        ? sum + (o.subscription_amount_cents ?? 0)
        : sum,
    0
  );
  const mrr = (mrrCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  const columns: Column<OrgRow>[] = [
    {
      key: "name",
      header: "Organization",
      cell: (o) => (
        <span className="font-medium text-gray-900 inline-flex items-center gap-1.5">
          <Building className="w-4 h-4 text-gray-400 flex-shrink-0" />
          {o.name}
        </span>
      ),
    },
    { key: "email", header: "Email", cell: (o) => o.email ?? "—" },
    {
      key: "members",
      header: "Members",
      align: "right",
      hideOnMobile: true,
      cell: (o) => counts.get(o.id) ?? 0,
    },
    {
      key: "plan",
      header: "Plan",
      hideOnMobile: true,
      cell: (o) => (o.plan ? <StatusBadge tone="neutral">{o.plan}</StatusBadge> : "—"),
    },
    {
      key: "status",
      header: "Status",
      cell: (o) =>
        o.plan_status && o.plan_status !== "trial" ? (
          <StatusBadge tone={PLAN_STATUS_TONE[o.plan_status] ?? "muted"}>
            {o.plan_status}
          </StatusBadge>
        ) : o.plan === "trial" && o.trial_ends_at ? (
          <span className="text-xs text-muted">
            trial ends {new Date(o.trial_ends_at).toLocaleDateString()}
          </span>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <PageContainer
      title="Platform"
      subtitle={`${list.length} organization${list.length === 1 ? "" : "s"} · ${mrr}/mo`}
      maxWidth="list"
    >
      <ListToolbar modes={MODES} defaultMode="cards" count={list.length} />

      {list.length === 0 ? (
        <p className="text-sm text-muted text-center py-6">No organizations yet.</p>
      ) : view === "table" ? (
        <DataTable columns={columns} rows={list} rowHref={(o) => `/admin/org?org=${o.id}`} />
      ) : (
        <div className="space-y-2">
          {list.map((org) => (
            <Link
              key={org.id}
              href={`/admin/org?org=${org.id}`}
              className="block bg-surface rounded-lg border border-line shadow-sm p-4 active:bg-gray-50"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate flex items-center gap-1.5">
                    <Building className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    {org.name}
                  </p>
                  {org.email && (
                    <p className="text-xs text-muted truncate mt-0.5">{org.email}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-xs text-gray-600 inline-flex items-center gap-1">
                      <UsersIcon className="w-3 h-3" />
                      {counts.get(org.id) ?? 0} members
                    </span>
                    {org.plan && (
                      <StatusBadge tone="neutral" className="uppercase tracking-wide">
                        {org.plan}
                      </StatusBadge>
                    )}
                    {org.plan_status && org.plan_status !== "trial" && (
                      <StatusBadge
                        tone={PLAN_STATUS_TONE[org.plan_status] ?? "muted"}
                        className="uppercase tracking-wide"
                      >
                        {org.plan_status}
                      </StatusBadge>
                    )}
                    {org.plan === "trial" && org.trial_ends_at && (
                      <span className="text-[10px] text-muted">
                        trial ends {new Date(org.trial_ends_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-1" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
