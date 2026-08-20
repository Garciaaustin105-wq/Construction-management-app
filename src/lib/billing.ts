// Server-only Stripe + subscription helpers for SaaS billing (flat per-org
// monthly). Imported only by server routes/webhooks. Stripe is dynamically
// imported so it stays out of the client/static bundles.
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLimits, priceIdToTier, TRIAL_DAYS, PLAN_TIERS } from "@/lib/plans";

// ---------------------------------------------------------------------------
// Stripe instance (lazy, shared)
// ---------------------------------------------------------------------------
let stripePromise: Promise<Stripe> | null = null;
export async function getStripe(): Promise<Stripe> {
  if (!stripePromise) {
    stripePromise = import("stripe").then((m) => {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
      return new m.default(key);
    });
  }
  return stripePromise;
}

// ---------------------------------------------------------------------------
// Org billing row + effective status
// ---------------------------------------------------------------------------
export interface OrgBilling {
  plan: string;
  planStatus: string;
  trialEndsAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionAmountCents: number;
}

const BILLING_COLS =
  "plan, plan_status, trial_ends_at, stripe_customer_id, stripe_subscription_id, subscription_amount_cents";

/** Read the caller's own org billing row (RLS-enforced — same_org select). */
export async function getOrgBilling(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgBilling | null> {
  const { data } = await supabase
    .from("organizations")
    .select(BILLING_COLS)
    .eq("id", orgId)
    .maybeSingle();
  if (!data) return null;
  return {
    plan: data.plan,
    planStatus: data.plan_status,
    trialEndsAt: data.trial_ends_at,
    stripeCustomerId: data.stripe_customer_id,
    stripeSubscriptionId: data.stripe_subscription_id,
    subscriptionAmountCents: data.subscription_amount_cents ?? 0,
  };
}

/** The effective plan/status, accounting for lazy trial expiry. */
export function effectiveStatus(b: OrgBilling): {
  plan: string;
  planStatus: string;
  isExpired: boolean;
} {
  if (
    b.plan === "trial" &&
    b.trialEndsAt &&
    Date.now() > new Date(b.trialEndsAt).getTime()
  ) {
    return { plan: "expired", planStatus: "expired", isExpired: true };
  }
  return { plan: b.plan, planStatus: b.planStatus, isExpired: false };
}

/** Full effective billing context for a route/page (row + effective status + limits). */
export async function getEffectiveBilling(
  supabase: SupabaseClient,
  orgId: string
) {
  const b = await getOrgBilling(supabase, orgId);
  if (!b) return null;
  const eff = effectiveStatus(b);
  return {
    ...b,
    ...eff,
    limits: getLimits(eff.plan),
  };
}

// ---------------------------------------------------------------------------
// Create-on gate: block new users/jobs when expired/canceled/trial-ended.
// Returns an error response shape, or null if creation is allowed.
// ---------------------------------------------------------------------------
export function createGate(b: OrgBilling): {
  ok: false;
  status: number;
  error: string;
} | null {
  const eff = effectiveStatus(b);
  if (eff.plan === "expired") {
    return {
      ok: false,
      status: 402,
      error: "Your trial has ended. Subscribe to a plan to keep creating.",
    };
  }
  if (eff.plan === "canceled") {
    return {
      ok: false,
      status: 402,
      error: "Your subscription is canceled. Resubscribe to resume creating.",
    };
  }
  // Past-due: a payment failed and Stripe is retrying. Block creates until the
  // customer updates their billing info (Customer Portal). Reads stay allowed.
  if (eff.planStatus === "past_due") {
    return {
      ok: false,
      status: 402,
      error:
        "Your subscription payment is past due. Update your billing info to resume creating.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stripe customer + checkout + portal
// ---------------------------------------------------------------------------
interface OrgForStripe {
  id: string;
  name: string;
  email: string | null;
  stripeCustomerId: string | null;
}

/** Ensure the org has a Stripe customer; create + stamp one if missing. */
export async function ensureStripeCustomer(
  org: OrgForStripe
): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId;
  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    name: org.name,
    email: org.email ?? undefined,
    metadata: { organization_id: org.id },
  });
  const admin = createAdminClient();
  await admin
    .from("organizations")
    .update({ stripe_customer_id: customer.id })
    .eq("id", org.id);
  return customer.id;
}

/** Start a Stripe Checkout session for a paid tier (flat per-org monthly). */
export async function createCheckoutSession(
  org: OrgForStripe,
  tier: "starter" | "pro" | "enterprise",
  origin: string
): Promise<{ url: string }> {
  const stripe = await getStripe();
  // Variant-aware: the price id for this tier on THIS deploy (construction vs
  // lawn) lives in PLAN_TIERS, resolved from STRIPE_PRICE_<TIER>_<VARIANT> env.
  const priceId = PLAN_TIERS[tier].priceId;
  if (!priceId) throw new Error(`Stripe price for ${tier} is not configured for this deploy`);
  const customerId = await ensureStripeCustomer(org);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: org.id,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { organization_id: org.id, tier } },
    success_url: `${origin}/admin/billing?status=success`,
    cancel_url: `${origin}/admin/billing?status=cancel`,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}

/** Open the Stripe Customer Portal (update card, cancel, view invoices).
 *
 *  Plan CHANGES are disabled in the portal (subscription_update.enabled=false)
 *  so the only way to switch tiers is our /api/billing/checkout route, where
 *  the downgrade guard runs. Without this lock, a tenant could swap to a
 *  cheaper plan in the portal and the webhook would overwrite organizations.plan
 *  — bypassing the guard entirely (the leak). Cancel stays enabled (cancel →
 *  canceled, which is fine). Card updates + invoice history stay enabled.
 *
 *  This Stripe API version's sessions.create accepts `configuration` as a
 *  CONFIGURATION ID only (not an inline object), so we create + cache a
 *  cancel-only portal configuration once per Stripe account and reference it by
 *  id. The config is a named (non-default) Stripe resource — harmless + can be
 *  deactivated in the Dashboard; creating it does not change the Dashboard's
 *  default config. Cached in module scope (one Stripe account → one config). */
let portalConfigId: string | null = null;

async function ensurePortalConfig(stripe: Stripe): Promise<string> {
  if (portalConfigId) return portalConfigId;
  // Reuse an existing active config that already disables plan changes, if one
  // exists (idempotent across restarts / deploys).
  const existing = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  const found = existing.data.find(
    (c) => c.features?.subscription_update?.enabled === false
  );
  if (found) {
    portalConfigId = found.id;
    return found.id;
  }
  const created = await stripe.billingPortal.configurations.create({
    features: {
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: true },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
    },
  });
  portalConfigId = created.id;
  return created.id;
}

export async function createPortalSession(
  org: OrgForStripe,
  origin: string
): Promise<{ url: string }> {
  if (!org.stripeCustomerId) throw new Error("No billing account to manage yet");
  const stripe = await getStripe();
  const configuration = await ensurePortalConfig(stripe);
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${origin}/admin/billing`,
    configuration,
  });
  return { url: session.url };
}

// ---------------------------------------------------------------------------
// Webhook: sync org plan/status from Stripe events
// ---------------------------------------------------------------------------
function subAmountCents(sub: Stripe.Subscription): number {
  const item = sub.items.data[0];
  if (!item) return 0;
  const unit = item.price.unit_amount ?? 0;
  return unit * (item.quantity ?? 1);
}

function subStatusToPlanStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "past_due"; // incomplete etc. — treat conservatively
  }
}

/** Apply a subscription object to its org row (find by Stripe customer id). */
async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return;
  const tier = sub.items.data[0]?.price?.id
    ? priceIdToTier(sub.items.data[0].price.id)
    : null;
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (!org) return; // event for an unknown customer — nothing to sync

  const status = subStatusToPlanStatus(sub.status);
  // A paying subscription whose price doesn't map to any configured tier
  // (price rotated/deleted in Stripe, or a priceId env var is unset) would
  // leave the org's plan unupdated — so a previously expired/canceled/trial
  // org would stay locked out despite paying. This is a misconfiguration, so
  // log it loudly instead of silently no-op'ing. Verify STRIPE_PRICE_STARTER /
  // STRIPE_PRICE_PRO / STRIPE_PRICE_ENTERPRISE match the live Stripe prices.
  if (!tier && status === "active") {
    const priceId = sub.items.data[0]?.price?.id ?? "(none)";
    console.error(
      `[billing] Subscription ${sub.id} (customer ${customerId}, org ${org.id}) is active but its price ${priceId} does not map to a configured tier — org plan was NOT updated. Check STRIPE_PRICE_* env vars.`
    );
  }
  const update: Record<string, unknown> = {
    plan_status: status,
    stripe_subscription_id: sub.id,
    subscription_amount_cents: subAmountCents(sub),
  };
  if (status === "canceled") {
    update.plan = "canceled";
    update.subscription_amount_cents = 0;
  } else if (tier) {
    update.plan = tier;
  }
  await admin.from("organizations").update(update).eq("id", org.id);
}

/** Find an org by Stripe customer id and patch a couple of columns (invoices). */
async function patchByCustomer(
  customerId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (!org) return;
  await admin.from("organizations").update(patch).eq("id", org.id);
}

/** Route a verified Stripe event to the right sync. */
export async function syncSubscriptionFromEvent(
  event: Stripe.Event
): Promise<void> {
  const stripe = await getStripe();
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const subId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        await applySubscription(sub);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      await applySubscription(event.data.object as Stripe.Subscription);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      if (customerId) {
        await patchByCustomer(customerId, {
          plan: "canceled",
          plan_status: "canceled",
          stripe_subscription_id: sub.id,
          subscription_amount_cents: 0,
        });
      }
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId =
        typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      if (customerId) await patchByCustomer(customerId, { plan_status: "active" });
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId =
        typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      if (customerId) await patchByCustomer(customerId, { plan_status: "past_due" });
      break;
    }
    default:
      // Unhandled event type — acknowledged, no-op.
      break;
  }
}

export { TRIAL_DAYS };