// Single source of truth for SaaS plan tiers (flat per-org monthly billing).
// The DB stores the current `plan` string + Stripe ids + amount; this module
// maps a plan -> its limits + Stripe price id. Safe to import from client code:
// price ids resolve from server-only env vars (undefined on the client -> null),
// so no secret leaks; the client only needs labels + limits + the tier order.

export const TRIAL_DAYS = 14;

export type PlanTier =
  | "trial"
  | "starter"
  | "pro"
  | "enterprise"
  | "expired"
  | "canceled";

export interface PlanConfig {
  label: string;
  /** Stripe price id (server env). null for non-purchasable tiers. */
  priceId: string | null;
  /** Max active users. null = unlimited. 0 = no creates allowed. */
  maxUsers: number | null;
  /** Max jobs. null = unlimited. 0 = no creates allowed. */
  maxJobs: number | null;
  /** Display order on the billing page. */
  order: number;
  /** One-line description for the billing cards. */
  blurb: string;
}

export const PLAN_TIERS: Record<PlanTier, PlanConfig> = {
  trial: {
    label: "Trial",
    priceId: null,
    maxUsers: null,
    maxJobs: null,
    order: 0,
    blurb: "Full access for 14 days — no card required.",
  },
  starter: {
    label: "Starter",
    priceId: process.env.STRIPE_PRICE_STARTER ?? null,
    maxUsers: 5,
    maxJobs: 10,
    order: 1,
    blurb: "For small crews getting organized.",
  },
  pro: {
    label: "Pro",
    priceId: process.env.STRIPE_PRICE_PRO ?? null,
    maxUsers: 25,
    maxJobs: 100,
    order: 2,
    blurb: "For growing contractors running multiple jobs.",
  },
  enterprise: {
    label: "Enterprise",
    priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? null,
    maxUsers: null,
    maxJobs: null,
    order: 3,
    blurb: "Unlimited users and jobs. For established operations.",
  },
  expired: {
    label: "Expired",
    priceId: null,
    maxUsers: 0,
    maxJobs: 0,
    order: 99,
    blurb: "Trial ended — subscribe to keep creating.",
  },
  canceled: {
    label: "Canceled",
    priceId: null,
    maxUsers: 0,
    maxJobs: 0,
    order: 99,
    blurb: "Subscription canceled — resubscribe to resume.",
  },
};

/** Purchasable tiers, in display order. */
export const PAID_TIERS = ["starter", "pro", "enterprise"] as const;
/** The narrow union of tiers a customer can buy (subset of PlanTier). */
export type PaidTier = (typeof PAID_TIERS)[number];

export function isPaidTier(plan: string): plan is PlanTier {
  return (PAID_TIERS as readonly string[]).includes(plan);
}

/** Resolve a Stripe price id back to a tier (used in the webhook). */
export function priceIdToTier(priceId: string): PlanTier | null {
  for (const tier of PAID_TIERS) {
    if (PLAN_TIERS[tier].priceId === priceId) return tier;
  }
  return null;
}

export function getPlanConfig(plan: string): PlanConfig {
  return PLAN_TIERS[plan as PlanTier] ?? PLAN_TIERS.trial;
}

export function getLimits(plan: string): { maxUsers: number | null; maxJobs: number | null } {
  const cfg = getPlanConfig(plan);
  return { maxUsers: cfg.maxUsers, maxJobs: cfg.maxJobs };
}