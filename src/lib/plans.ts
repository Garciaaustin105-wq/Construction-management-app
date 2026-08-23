// Single source of truth for SaaS plan tiers (flat per-org monthly billing).
// The DB stores the current `plan` string + Stripe ids + amount; this module
// maps a plan -> its limits + Stripe price id. Safe to import from client code:
// price ids resolve from server-only env vars (undefined on the client -> null),
// so no secret leaks; the client only needs labels + limits + the tier order.
//
// VARIANT-AWARE (2026-08-17): the two deploys (construction default | lawn) each
// show their OWN pricing + limits via build-time isLawn() (NEXT_PUBLIC_APP_VARIANT).
// The internal tier keys stay stable — trial/starter/pro/enterprise — so NO DB
// migration of organizations.plan is needed. `enterprise` is LABELED "Business"
// (the top paid tier); its key is unchanged so the webhook + checkout + RLS
// keep resolving. Each variant reads its own Stripe price env vars:
//   construction: STRIPE_PRICE_STARTER_CONSTRUCTION / _PRO_ / _ENTERPRISE_
//   lawn:         STRIPE_PRICE_STARTER_LAWN / _PRO_ / _ENTERPRISE_
//
// MULTI-DIMENSIONAL (2026-08-17): tiers restrict more than headcount — jobs,
// line-items-per-doc, storage, app-user seats, crew members (scheduling-only +
// linked), and customers. NO unlimited storage anywhere (it costs the platform
// too much); the Business tier's storage is a soft "call/email for more" ceiling
// (storageCustom) — see storage cost research in the payments-pivot topic.

import { isLawn } from "@/lib/variant";

export const TRIAL_DAYS = 30;

export type PlanTier =
  | "free"
  | "trial"
  | "starter"
  | "pro"
  | "enterprise"
  | "expired"
  | "canceled";

export interface PlanConfig {
  label: string;
  /** Stripe price id for THIS deploy's variant (server env). null for non-purchasable tiers. */
  priceId: string | null;
  /** Display price in whole dollars (for the billing cards). 0 for trial. */
  priceMonthly: number;
  /** Max active app-user seats (logins). null = unlimited. 0 = no creates. */
  maxUsers: number | null;
  /** Max active jobs. For lawn, a "job" is a property with a recurring plan, so
   *  this doubles as the recurring-schedules cap (≈1 schedule per lawn job).
   *  null = unlimited. 0 = no creates. */
  maxJobs: number | null;
  /** Max line items per estimate/invoice. null = unlimited. */
  maxLineItemsPerDoc: number | null;
  /** Max storage in bytes across the org's photos/receipts/blueprints. null = unlimited. */
  maxStorageBytes: number | null;
  /** When true, the storage cap is a soft ceiling — the user calls/emails to ask
   *  for more (Business tier). The hard byte cap still applies as the included allotment. */
  storageCustom: boolean;
  /** Max crew_members (linked app-user crew + scheduling-only). null = unlimited. */
  maxCrewMembers: number | null;
  /** Max customers. null = unlimited. */
  maxCustomers: number | null;
  /** Max AI actions (LLM calls — photo analysis, assistants, etc.) per calendar
   *  month per org. Variant-INDEPENDENT (LLM cost doesn't depend on variant).
   *  null = unlimited. 0 = AI disabled on this tier. trial gets a taste (25),
   *  starter none, pro 100, Business 5000, expired/canceled 0. Mirrored in
   *  ai_action_gating.sql ai_action_max() so the DB + app agree. */
  maxAiActionsPerMonth: number | null;
  /** Max route optimizations (Google Distance Matrix calls) per calendar day
   *  per org. Variant-INDEPENDENT (Google bills per call regardless of variant).
   *  null = unlimited (paid + trial). 0 = route opt disabled (expired/canceled).
   *  free = 5/day (the conversion hook — capped, not blocked). Mirrored in
   *  route_opt_quota.sql route_opt_max() so the DB + app agree. */
  maxRouteOptsPerDay: number | null;
  /** Display order on the billing page. */
  order: number;
  /** One-line description for the billing cards. */
  blurb: string;
}

const GB = 1024 * 1024 * 1024;

// ── Construction variant ──────────────────────────────────────────────────────
const CONSTRUCTION_TIERS: Record<PlanTier, PlanConfig> = {
  trial: {
    label: "Trial",
    priceId: null,
    priceMonthly: 0,
    maxUsers: null,
    maxJobs: null,
    maxLineItemsPerDoc: null,
    maxStorageBytes: null,
    storageCustom: false,
    maxCrewMembers: null,
    maxCustomers: null,
    maxAiActionsPerMonth: 25,
    maxRouteOptsPerDay: null,
    order: 0,
    blurb: "Full access for 30 days — no card required.",
  },
  // free is a LAWN-ONLY tier (construction keeps the trial). It's defined here
  // only because the Record<PlanTier, PlanConfig> type requires every key — no
  // construction code path ever emits plan='free'. Defense-in-depth: if a DB
  // edit/bug ever sets a construction org to free, these bounded caps (matching
  // the lawn free tier) apply instead of the unlimited fall-through to trial.
  free: {
    label: "Free",
    priceId: null,
    priceMonthly: 0,
    maxUsers: 1,
    maxJobs: 25,
    maxLineItemsPerDoc: 10,
    maxStorageBytes: 1 * GB,
    storageCustom: false,
    maxCrewMembers: 3,
    maxCustomers: 25,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: 5,
    order: -1,
    blurb: "Solo operator, up to 25 customers. No card required.",
  },
  starter: {
    label: "Starter",
    // Falls back to the legacy single price env until the variant-specific
    // price is set, so this deploy keeps working during the price migration.
    priceId: process.env.STRIPE_PRICE_STARTER_CONSTRUCTION ?? process.env.STRIPE_PRICE_STARTER ?? null,
    priceMonthly: 49,
    maxUsers: 5,
    maxJobs: 10,
    maxLineItemsPerDoc: 25,
    maxStorageBytes: 5 * GB,
    storageCustom: false,
    maxCrewMembers: 15,
    maxCustomers: 50,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: null,
    order: 1,
    blurb: "For small crews getting organized.",
  },
  pro: {
    label: "Pro",
    priceId: process.env.STRIPE_PRICE_PRO_CONSTRUCTION ?? process.env.STRIPE_PRICE_PRO ?? null,
    priceMonthly: 149,
    maxUsers: 25,
    maxJobs: 50,
    maxLineItemsPerDoc: 75,
    maxStorageBytes: 25 * GB,
    storageCustom: false,
    maxCrewMembers: 100,
    maxCustomers: 500,
    maxAiActionsPerMonth: 100,
    maxRouteOptsPerDay: null,
    order: 2,
    blurb: "For growing contractors running multiple jobs.",
  },
  enterprise: {
    label: "Business",
    priceId: process.env.STRIPE_PRICE_ENTERPRISE_CONSTRUCTION ?? process.env.STRIPE_PRICE_ENTERPRISE ?? null,
    priceMonthly: 399,
    maxUsers: null,
    maxJobs: null,
    maxLineItemsPerDoc: null,
    maxStorageBytes: 100 * GB,
    storageCustom: true,
    maxCrewMembers: null,
    maxCustomers: null,
    maxAiActionsPerMonth: 5000,
    maxRouteOptsPerDay: null,
    order: 3,
    blurb: "Unlimited users + jobs. Need more storage? Call us.",
  },
  expired: {
    label: "Expired",
    priceId: null,
    priceMonthly: 0,
    maxUsers: 0,
    maxJobs: 0,
    maxLineItemsPerDoc: 0,
    maxStorageBytes: 0,
    storageCustom: false,
    maxCrewMembers: 0,
    maxCustomers: 0,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: 0,
    order: 99,
    blurb: "Trial ended — subscribe to keep creating.",
  },
  canceled: {
    label: "Canceled",
    priceId: null,
    priceMonthly: 0,
    maxUsers: 0,
    maxJobs: 0,
    maxLineItemsPerDoc: 0,
    maxStorageBytes: 0,
    storageCustom: false,
    maxCrewMembers: 0,
    maxCustomers: 0,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: 0,
    order: 99,
    blurb: "Subscription canceled — resubscribe to resume.",
  },
};

// ── Lawn variant ──────────────────────────────────────────────────────────────
// More seats + crew members than construction (lawn businesses staff many crews,
// many of whom are scheduling-only). Jobs = recurring service plans.
const LAWN_TIERS: Record<PlanTier, PlanConfig> = {
  trial: {
    label: "Trial",
    priceId: null,
    priceMonthly: 0,
    maxUsers: null,
    maxJobs: null,
    maxLineItemsPerDoc: null,
    maxStorageBytes: null,
    storageCustom: false,
    maxCrewMembers: null,
    maxCustomers: null,
    maxAiActionsPerMonth: 25,
    maxRouteOptsPerDay: null,
    order: 0,
    blurb: "Full access for 30 days — no card required.",
  },
  // free is the lawn variant's default signup tier — a persistent, capped,
  // no-card plan that REPLACES the 30-day trial (decision 2026-08-22). It gives
  // the solo operator the operational power competitors gate (seasonal pause,
  // skip-visit, working route-opt, bulk scheduling, before/after photos — all
  // already built) and walls at 25 customers / 1 seat / 1GB. Paid differentiators
  // + real-future-cost items are gated: accounting sync (route gate, Step 6),
  // AI (0 actions), route-opt-at-scale (5/day soft cap, full server cap is the
  // Step 7 fast-follow). Cancel-to-free: a paid lawn sub that cancels drops here
  // (keeps data, new creates blocked by the DB triggers until under cap).
  free: {
    label: "Free",
    priceId: null,
    priceMonthly: 0,
    maxUsers: 1,
    maxJobs: 25,
    maxLineItemsPerDoc: 10,
    maxStorageBytes: 1 * GB,
    storageCustom: false,
    maxCrewMembers: 3,
    maxCustomers: 25,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: 5,
    order: -1,
    blurb: "Solo operator, up to 25 customers. No card required.",
  },
  starter: {
    label: "Starter",
    priceId: process.env.STRIPE_PRICE_STARTER_LAWN ?? process.env.STRIPE_PRICE_STARTER ?? null,
    priceMonthly: 29,
    maxUsers: 5,
    maxJobs: 25,
    maxLineItemsPerDoc: 15,
    maxStorageBytes: 5 * GB,
    storageCustom: false,
    maxCrewMembers: 25,
    maxCustomers: 100,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: null,
    order: 1,
    blurb: "For a solo operator or small route.",
  },
  pro: {
    label: "Pro",
    priceId: process.env.STRIPE_PRICE_PRO_LAWN ?? process.env.STRIPE_PRICE_PRO ?? null,
    priceMonthly: 149,
    maxUsers: 25,
    maxJobs: 150,
    maxLineItemsPerDoc: 50,
    // 2026-08-19: bumped 25GB -> 75GB. Lawn before/after photos accumulate
    // (~36MB/yard/yr), so a full 150-yard Pro filled 25GB in ~4yr and hit the
    // hard block — the stranding wall we don't want for loyal customers. 75GB
    // gives ~14yr at typical use (or ~5yr if crews take 8 photos/visit). Cost
    // is trivial (~$1.50/mo) at the $149 Pro price. Construction Pro stays
    // 25GB (separate research).
    maxStorageBytes: 75 * GB,
    storageCustom: false,
    maxCrewMembers: 150,
    maxCustomers: 1000,
    maxAiActionsPerMonth: 100,
    maxRouteOptsPerDay: null,
    order: 2,
    blurb: "For growing lawn businesses with multiple crews.",
  },
  enterprise: {
    label: "Business",
    priceId: process.env.STRIPE_PRICE_ENTERPRISE_LAWN ?? process.env.STRIPE_PRICE_ENTERPRISE ?? null,
    priceMonthly: 199,
    maxUsers: 75,
    maxJobs: 500,
    maxLineItemsPerDoc: null,
    maxStorageBytes: 75 * GB,
    storageCustom: true,
    maxCrewMembers: null,
    maxCustomers: null,
    maxAiActionsPerMonth: 5000,
    maxRouteOptsPerDay: null,
    order: 3,
    blurb: "For established operations. Need more storage? Call us.",
  },
  expired: {
    label: "Expired",
    priceId: null,
    priceMonthly: 0,
    maxUsers: 0,
    maxJobs: 0,
    maxLineItemsPerDoc: 0,
    maxStorageBytes: 0,
    storageCustom: false,
    maxCrewMembers: 0,
    maxCustomers: 0,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: 0,
    order: 99,
    blurb: "Trial ended — subscribe to keep creating.",
  },
  canceled: {
    label: "Canceled",
    priceId: null,
    priceMonthly: 0,
    maxUsers: 0,
    maxJobs: 0,
    maxLineItemsPerDoc: 0,
    maxStorageBytes: 0,
    storageCustom: false,
    maxCrewMembers: 0,
    maxCustomers: 0,
    maxAiActionsPerMonth: 0,
    maxRouteOptsPerDay: 0,
    order: 99,
    blurb: "Subscription canceled — resubscribe to resume.",
  },
};

export const PLAN_TIERS: Record<PlanTier, PlanConfig> = isLawn()
  ? LAWN_TIERS
  : CONSTRUCTION_TIERS;

/** Purchasable tiers, in display order. */
export const PAID_TIERS = ["starter", "pro", "enterprise"] as const;
/** The narrow union of tiers a customer can buy (subset of PlanTier). */
export type PaidTier = (typeof PAID_TIERS)[number];

export function isPaidTier(plan: string): plan is PlanTier {
  return (PAID_TIERS as readonly string[]).includes(plan);
}

/** Resolve a Stripe price id back to a tier (used in the webhook). Matches
 *  only the current STRIPE_PRICE_<TIER>_<VARIANT> price ids. */
export function priceIdToTier(priceId: string): PlanTier | null {
  for (const tier of PAID_TIERS) {
    if (PLAN_TIERS[tier].priceId === priceId) return tier;
  }
  return null;
}

export function getPlanConfig(plan: string): PlanConfig {
  return PLAN_TIERS[plan as PlanTier] ?? PLAN_TIERS.trial;
}

/** Full multi-dimensional limits for a plan. Consumed by create guards
 *  (seats, crew_members, customers, line-items, storage) + the billing UI. */
export interface PlanLimits {
  maxUsers: number | null;
  maxJobs: number | null;
  maxLineItemsPerDoc: number | null;
  maxStorageBytes: number | null;
  storageCustom: boolean;
  maxCrewMembers: number | null;
  maxCustomers: number | null;
  maxAiActionsPerMonth: number | null;
  maxRouteOptsPerDay: number | null;
}

export function getLimits(plan: string): PlanLimits {
  const cfg = getPlanConfig(plan);
  return {
    maxUsers: cfg.maxUsers,
    maxJobs: cfg.maxJobs,
    maxLineItemsPerDoc: cfg.maxLineItemsPerDoc,
    maxStorageBytes: cfg.maxStorageBytes,
    storageCustom: cfg.storageCustom,
    maxCrewMembers: cfg.maxCrewMembers,
    maxCustomers: cfg.maxCustomers,
    maxAiActionsPerMonth: cfg.maxAiActionsPerMonth,
    maxRouteOptsPerDay: cfg.maxRouteOptsPerDay,
  };
}