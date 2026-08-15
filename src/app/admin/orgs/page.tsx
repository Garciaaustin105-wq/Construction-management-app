import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import { Building, Users as UsersIcon, ArrowRight } from "lucide-react";
import { getMyOrg } from "@/lib/tenant";

// Platform view — super_admin only. Lists every organization with a member
// count and a link to edit that org's business info. Any non-super_admin is
// bounced to the dashboard.
export default async function OrgsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const tenant = await getMyOrg(supabase);
  if (!tenant || !tenant.isSuperAdmin) redirect("/dashboard");

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

  const list = (orgs ?? []) as {
    id: string;
    name: string;
    email: string | null;
    plan: string | null;
    plan_status: string | null;
    trial_ends_at: string | null;
    subscription_amount_cents: number | null;
    created_at: string;
  }[];

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

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar
        title="Platform"
        subtitle={`${list.length} organization${list.length === 1 ? "" : "s"} · ${mrr}/mo`}
      />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <div className="space-y-2">
          {list.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-6">
              No organizations yet.
            </p>
          )}
          {list.map((org) => (
            <Link
              key={org.id}
              href={`/admin/org?org=${org.id}`}
              className="block bg-white rounded-lg p-4 shadow-sm active:bg-gray-50"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate flex items-center gap-1.5">
                    <Building className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    {org.name}
                  </p>
                  {org.email && (
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {org.email}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-xs text-gray-600 inline-flex items-center gap-1">
                      <UsersIcon className="w-3 h-3" />
                      {counts.get(org.id) ?? 0} members
                    </span>
                    {org.plan && (
                      <span className="text-[10px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {org.plan}
                      </span>
                    )}
                    {org.plan_status && org.plan_status !== "trial" && (
                      <span
                        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                          org.plan_status === "active"
                            ? "bg-green-100 text-green-700"
                            : org.plan_status === "past_due"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {org.plan_status}
                      </span>
                    )}
                    {org.plan === "trial" && org.trial_ends_at && (
                      <span className="text-[10px] text-gray-500">
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
      </main>
    </div>
  );
}