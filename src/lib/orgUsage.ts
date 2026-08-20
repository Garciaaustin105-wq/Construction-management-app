import type { SupabaseClient } from "@supabase/supabase-js";
import { PLAN_TIERS, type PlanLimits } from "@/lib/plans";

// Per-org current usage for the downgrade guard. Counts mirror the SQL create
// triggers in plan_limits_v2.sql EXACTLY (all rows, no status filter) and the
// app seat count in /api/users/route.ts (profiles where role <> 'customer') so
// a guard that passes here is consistent with what the create gates enforce —
// a user can't be told "downgrade OK" then find the create gates block them.
//
// storageBytes comes from organizations.storage_bytes, maintained by the
// storage_cap.sql triggers (Part 1 of the pricing-enforcement work).

export interface OrgUsage {
  jobs: number;
  customers: number;
  crewMembers: number;
  seats: number;
  storageBytes: number;
}

/** Count the org's current usage across all downgrade-relevant dimensions.
 *  Works with either the RLS session client (admin reads own org) or the
 *  service-role admin client. */
export async function getOrgUsage(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgUsage> {
  const [jobs, customers, crewMembers, seats, org] = await Promise.all([
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    supabase
      .from("crew_members")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .neq("role", "customer"),
    supabase
      .from("organizations")
      .select("storage_bytes")
      .eq("id", orgId)
      .maybeSingle(),
  ]);

  return {
    jobs: jobs.count ?? 0,
    customers: customers.count ?? 0,
    crewMembers: crewMembers.count ?? 0,
    seats: seats.count ?? 0,
    storageBytes: Number(org.data?.storage_bytes ?? 0) || 0,
  };
}

/** A downgrade = target tier is a LOWER order than the current effective plan.
 *  trial (0) → paid is NOT a downgrade (trial conversion is a purchase moment —
 *  don't block it; the create gates cap future growth). expired/canceled (99) →
 *  paid IS treated as a downgrade so a lapsed org can't resubscribe to a cheap
 *  tier while holding over-cap capacity from a higher one. paid → lower-paid is
 *  the core case. paid → same/higher is not. */
export function isDowngrade(fromPlan: string, toPlan: string): boolean {
  const from = PLAN_TIERS[fromPlan as keyof typeof PLAN_TIERS];
  const to = PLAN_TIERS[toPlan as keyof typeof PLAN_TIERS];
  if (!from || !to) return false;
  return to.order < from.order;
}

export type DowngradeBlocker = {
  dim: "jobs" | "customers" | "crewMembers" | "seats" | "storage";
  label: string;
  current: number;
  cap: number;
  /** How many the user must remove (current - cap). */
  mustRemove: number;
};

/** Dimensions where current usage exceeds the target tier's cap. null cap
 *  (unlimited) never blocks. Returns [] when the downgrade is allowed. */
export function downgradeBlockers(
  usage: OrgUsage,
  target: PlanLimits
): DowngradeBlocker[] {
  const blockers: DowngradeBlocker[] = [];
  const check = (
    dim: DowngradeBlocker["dim"],
    label: string,
    current: number,
    cap: number | null
  ) => {
    if (cap !== null && current > cap) {
      blockers.push({ dim, label, current, cap, mustRemove: current - cap });
    }
  };
  check("jobs", "Jobs", usage.jobs, target.maxJobs);
  check("customers", "Customers", usage.customers, target.maxCustomers);
  check("crewMembers", "Crew members", usage.crewMembers, target.maxCrewMembers);
  check("seats", "App users", usage.seats, target.maxUsers);
  check("storage", "Storage", usage.storageBytes, target.maxStorageBytes);
  return blockers;
}