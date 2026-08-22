// Server-only Stripe helpers for ISP SUBSCRIBER billing (fiber plans billed by
// an org to its own end customers). Imported only by server routes / webhooks /
// crons.
//
// ===========================================================================
// READ THIS FIRST — how this does NOT reverse the 2026-08-17 payments pivot
// ===========================================================================
// The pivot's rule is "the platform never touches customer money." At a glance
// this file looks like a violation: it calls Stripe with STRIPE_SECRET_KEY (the
// PLATFORM key) to charge an org's customers. It isn't, and the distinction is
// worth being precise about because it is the whole safety argument:
//
//   * The platform key is used only as the API CALLER. Every call below passes
//     `forAccount(acct)` → the Stripe-Account header, which makes the ORG's
//     connected account the account the object is created ON.
//   * The resulting charge lives on the ORG's balance. It never enters, passes
//     through, or settles in the platform's balance. There is no application
//     fee, no destination, no transfer. We take nothing.
//   * Therefore the ORG is merchant of record: their disputes, their refunds,
//     their payouts, their Stripe fees, their 1099s.
//
// The thing that would break this is switching to DESTINATION charges (or
// separate charges + transfers). Those create the charge on the PLATFORM and
// then move funds out — which puts every subscriber chargeback on our balance
// and makes Stripe hold a reserve against us. That is exactly what the removed
// commit e2cf93c did (Express accounts + destination charges), and why it was
// torn out. If you are about to add `transfer_data`, `application_fee_amount`,
// or `on_behalf_of` to anything in this file: don't.
//
// src/lib/billing.ts stays PLATFORM-SaaS-ONLY and is not modified — getStripe()
// is imported, not redefined, so there is exactly one Stripe client factory.
//
// SQL/RLS/auth/security stay Claude-direct per [[lowvoltage-local-model-delegation]].

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/billing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IspConnectAccount = {
  id: string;
  organization_id: string;
  stripe_account_id: string;
  status: "pending" | "active" | "restricted" | "disconnected";
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  livemode: boolean;
  requirements: Record<string, unknown> | null;
  connected_at: string | null;
};

/** Our subscription vocabulary. Deliberately NOT Stripe's — see below. */
export type IspSubStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "suspended"
  | "canceled";

const CONNECT_COLS =
  "id, organization_id, stripe_account_id, status, charges_enabled, payouts_enabled, details_submitted, livemode, requirements, connected_at";

// ---------------------------------------------------------------------------
// The Stripe-Account header
// ---------------------------------------------------------------------------

/**
 * Request options that execute a call ON the org's connected account.
 *
 * Every Stripe object belonging to an org's subscribers — Customer, Product,
 * Price, Subscription, Invoice, PaymentMethod, BillingPortal session — must be
 * created with these options. An object created WITHOUT them silently lands in
 * the platform account instead, where it is both wrong and invisible to the
 * org. When in doubt, pass it.
 */
export function forAccount(stripeAccountId: string): Stripe.RequestOptions {
  return { stripeAccount: stripeAccountId };
}

/**
 * Whether we are operating against live Stripe.
 *
 * Derived from the platform key rather than read off the Account object: the
 * SDK's `Account` type doesn't declare `livemode`, and the derivation is exact
 * anyway — a test-mode platform key can only ever create test-mode connected
 * accounts. Stored per-row so a key swap can't silently mislabel history.
 */
function isLiveMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_");
}

// ---------------------------------------------------------------------------
// Connected account lifecycle
// ---------------------------------------------------------------------------

/** Read an org's connect row (service role → bypasses RLS). Null if unconnected. */
export async function getConnectAccount(
  organizationId: string
): Promise<IspConnectAccount | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("isp_connect_accounts")
    .select(CONNECT_COLS)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data as IspConnectAccount | null) ?? null;
}

/** Resolve which org a connected account belongs to (webhook routing). */
export async function getOrgForStripeAccount(
  stripeAccountId: string
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("isp_connect_accounts")
    .select("organization_id")
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle();
  return (data?.organization_id as string | null) ?? null;
}

/**
 * Create the org's connected account.
 *
 * ==== THE LIABILITY-CRITICAL CALL. Change nothing here casually. ====
 *
 * `controller` replaces the deprecated `type: "standard" | "express" | ...`
 * shorthand (Stripe deprecated the legacy account types; the controller
 * properties spell out what those types used to imply). This combination is
 * the Standard-account equivalent:
 *
 *   stripe_dashboard.type = "full"
 *     The org gets a real, full Stripe Dashboard they log into themselves —
 *     they manage their own disputes, payouts, and payment methods, and they
 *     can disconnect this platform from their own settings. This is also what
 *     makes Stripe (not us) responsible for collecting their KYC.
 *
 *   losses.payments = "stripe"
 *     Stripe — NOT this platform — absorbs unrecoverable negative balances on
 *     the connected account. This is the single property that keeps a
 *     subscriber's chargeback off our books. It is only permitted alongside
 *     direct charges; Stripe explicitly recommends against it for destination
 *     charges, which is another reason not to switch charge types.
 *
 *   fees.payer = "account"
 *     The org pays Stripe's processing fees directly out of their own volume.
 *     We are not in the fee chain at all.
 *
 *   requirement_collection = "stripe"
 *     Stripe runs onboarding/verification and keeps it current as regulations
 *     change. We never collect, store, or become responsible for KYC data.
 *
 * Capabilities: card_payments is what direct charges actually need. transfers
 * is requested alongside because Stripe's onboarding treats the pair as the
 * normal merchant setup and some payout configurations expect it; it does NOT
 * imply we will ever create a transfer, and we don't.
 */
export async function createConnectedAccount(org: {
  id: string;
  name: string | null;
  email: string | null;
}): Promise<string> {
  const stripe = await getStripe();

  const account = await stripe.accounts.create({
    controller: {
      stripe_dashboard: { type: "full" },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    ...(org.email ? { email: org.email } : {}),
    ...(org.name ? { business_profile: { name: org.name } } : {}),
    // Lets us resolve the org from a webhook even before our row is committed.
    metadata: { organization_id: org.id },
  });

  const admin = createAdminClient();
  const { error } = await admin.from("isp_connect_accounts").upsert(
    {
      organization_id: org.id,
      stripe_account_id: account.id,
      status: "pending",
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
      details_submitted: account.details_submitted ?? false,
      livemode: isLiveMode(),
      connected_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" }
  );
  if (error) throw error;

  return account.id;
}

/**
 * A single-use Stripe-hosted onboarding URL.
 *
 * Account Links expire within minutes and are single-use by design — they grant
 * access to the account holder's personal information, so they must be handed
 * to an already-authenticated user in-app and never emailed or texted. The
 * refresh_url exists precisely because the link WILL go stale (back button,
 * refresh, expiry); it must re-mint a link rather than showing an error.
 */
export async function createOnboardingLink(
  stripeAccountId: string,
  origin: string
): Promise<string> {
  const stripe = await getStripe();
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${origin}/admin/isp/billing?connect=refresh`,
    return_url: `${origin}/admin/isp/billing?connect=return`,
    type: "account_onboarding",
  });
  if (!link.url) throw new Error("Stripe returned an account link with no URL");
  return link.url;
}

/**
 * Re-read the account from Stripe and persist the capability flags.
 *
 * Called on return from onboarding and from `account.updated` webhooks. The
 * stored flags are a CACHE for rendering; this is the only thing that refreshes
 * them. Returning to return_url does NOT mean onboarding completed — Stripe is
 * explicit that it only means the flow was entered and exited — so the UI must
 * read charges_enabled from here rather than assuming success.
 */
export async function refreshConnectAccount(
  organizationId: string
): Promise<IspConnectAccount | null> {
  const row = await getConnectAccount(organizationId);
  if (!row) return null;

  const stripe = await getStripe();
  const account = await stripe.accounts.retrieve(row.stripe_account_id);

  const chargesEnabled = account.charges_enabled ?? false;
  const disabledReason = account.requirements?.disabled_reason ?? null;

  // 'restricted' means Stripe has switched charges off pending information —
  // distinct from 'pending' (onboarding never finished) because the org needs
  // a different message: something WAS working and now isn't.
  const status: IspConnectAccount["status"] = chargesEnabled
    ? "active"
    : account.details_submitted && disabledReason
      ? "restricted"
      : "pending";

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("isp_connect_accounts")
    .update({
      status,
      charges_enabled: chargesEnabled,
      payouts_enabled: account.payouts_enabled ?? false,
      details_submitted: account.details_submitted ?? false,
      livemode: isLiveMode(),
      requirements: (account.requirements ?? null) as Record<string, unknown> | null,
    })
    .eq("organization_id", organizationId)
    .select(CONNECT_COLS)
    .maybeSingle();
  if (error) throw error;
  return (data as IspConnectAccount | null) ?? null;
}

/**
 * The org's connected account, guaranteed able to accept charges.
 *
 * Every enroll/charge path funnels through this rather than reading the row
 * directly, so "we tried to bill someone on a half-onboarded account" is one
 * failure with one clear message instead of an opaque Stripe error surfacing
 * from five different call sites.
 */
export async function requireChargeableAccount(
  organizationId: string
): Promise<IspConnectAccount> {
  const row = await getConnectAccount(organizationId);
  if (!row) {
    throw new Error(
      "This organization has not connected a Stripe account yet. Connect one under Settings → ISP Billing."
    );
  }
  if (row.status === "disconnected") {
    throw new Error(
      "This organization's Stripe account has been disconnected. Reconnect it to resume billing."
    );
  }
  if (!row.charges_enabled) {
    throw new Error(
      "This organization's Stripe account cannot accept charges yet. Finish Stripe onboarding under Settings → ISP Billing."
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Plan → Stripe Product/Price, on the org's account
// ---------------------------------------------------------------------------

export type IspPlanRow = {
  id: string;
  organization_id: string;
  name: string;
  price_cents: number;
  billing_interval: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
};

/**
 * Resolve (creating if needed) the Stripe Price backing a plan, on the ORG's
 * connected account.
 *
 * Lazy on purpose: an org builds their catalog before they finish Stripe
 * onboarding, so creating Stripe objects at plan-insert time would fail for the
 * most common ordering. This runs at first enrollment instead.
 *
 * PRICE IMMUTABILITY: Stripe Prices cannot be edited. When the office changes
 * price_cents, the plan's stripe_price_id is cleared (see the plans route) and
 * this mints a fresh Price on the next enrollment. Existing subscribers keep
 * billing at the old Price until someone explicitly migrates them — silently
 * repricing live customers is how you earn a wave of disputes.
 */
export async function ensurePlanPrice(
  plan: IspPlanRow,
  stripeAccountId: string
): Promise<string> {
  if (plan.stripe_price_id) return plan.stripe_price_id;

  const stripe = await getStripe();
  const opts = forAccount(stripeAccountId);

  let productId = plan.stripe_product_id;
  if (!productId) {
    const product = await stripe.products.create(
      {
        name: plan.name,
        metadata: { isp_plan_id: plan.id, organization_id: plan.organization_id },
      },
      opts
    );
    productId = product.id;
  }

  const price = await stripe.prices.create(
    {
      product: productId,
      unit_amount: plan.price_cents,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { isp_plan_id: plan.id },
    },
    opts
  );

  const admin = createAdminClient();
  const { error } = await admin
    .from("isp_plans")
    .update({ stripe_product_id: productId, stripe_price_id: price.id })
    .eq("id", plan.id);
  if (error) throw error;

  return price.id;
}

// ---------------------------------------------------------------------------
// Subscriber → Stripe Customer, on the org's account
// ---------------------------------------------------------------------------

/**
 * Resolve (creating if needed) the subscriber's Stripe Customer on the org's
 * connected account.
 *
 * Reuse matters more than it looks: the Customer holds the saved card. Creating
 * a second Customer for someone who already has one orphans their payment
 * method, which surfaces later as an inexplicable payment failure on renewal.
 */
export async function ensureStripeCustomer(
  sub: { id: string; stripe_customer_id: string | null },
  customer: { id: string; name: string; contact_email: string | null; phone: string | null },
  stripeAccountId: string
): Promise<string> {
  if (sub.stripe_customer_id) return sub.stripe_customer_id;

  const stripe = await getStripe();
  const created = await stripe.customers.create(
    {
      name: customer.name,
      ...(customer.contact_email ? { email: customer.contact_email } : {}),
      ...(customer.phone ? { phone: customer.phone } : {}),
      metadata: { app_customer_id: customer.id },
    },
    forAccount(stripeAccountId)
  );

  const admin = createAdminClient();
  const { error } = await admin
    .from("isp_subscriptions")
    .update({ stripe_customer_id: created.id })
    .eq("id", sub.id);
  if (error) throw error;

  return created.id;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map a Stripe subscription status onto ours.
 *
 * Two asymmetries are deliberate and must not be "fixed":
 *
 *  1. 'suspended' is NOT produced here. It is this app's post-grace service
 *     cutoff, applied only by the dunning cron. Stripe has no such concept, so
 *     nothing Stripe sends should ever map to it.
 *  2. A currently-suspended row must NOT be knocked back to 'past_due' just
 *     because Stripe re-reports past_due on a retry. Callers pass the current
 *     status so we can hold the suspension until an actual payment succeeds.
 */
export function mapStripeStatus(
  stripeStatus: Stripe.Subscription.Status,
  currentStatus?: IspSubStatus | null
): IspSubStatus {
  if (currentStatus === "suspended" && stripeStatus !== "active" && stripeStatus !== "trialing") {
    return "suspended";
  }
  switch (stripeStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
    case "paused":
    default:
      return "none";
  }
}
