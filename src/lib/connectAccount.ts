// Server-only Stripe Connect helpers for the ORG's connected account — the
// account an org connects so its customers can pay invoices online. Imported
// only by server routes + the Connect webhook + cycle billing.
//
// ===========================================================================
// READ THIS FIRST — how this stays OFF the platform's balance (liability)
// ===========================================================================
// The pivot's rule is "the platform never touches customer money." This file
// calls Stripe with STRIPE_SECRET_KEY (the PLATFORM key) to charge an org's
// customers, so it looks like a violation. It isn't, and the distinction is
// the whole safety argument:
//
//   * The platform key is used only as the API CALLER. Every call below passes
//     `forAccount(acct)` → the Stripe-Account header, which makes the ORG's
//     connected account the account the object is created ON.
//   * The resulting charge lives on the ORG's balance. It never enters, passes
//     through, or settles in the platform's balance. There is no application
//     fee, no destination, no transfer. We take nothing.
//   * Therefore the ORG is merchant of record: their disputes, their refunds,
//     their payouts, their Stripe fees, their 1099s. We are NOT liable.
//
// The thing that would break this is switching to DESTINATION charges (or
// separate charges + transfers). Those create the charge on the PLATFORM and
// then move funds out — which puts every customer chargeback on our balance
// and makes Stripe hold a reserve against us. That is exactly what the removed
// "Pay Here" code did (Express accounts + transfer_data.destination), and why
// it was torn out in 2026-08-18 (3ea62c3 + 4e5dad3). If you are about to add
// `transfer_data`, `application_fee_amount`, or `on_behalf_of` to anything in
// this file or invoicePay.ts: don't. The org keeps 100% of every payment.
//
// The connected account lives on the EXISTING `organizations` columns
// (stripe_connect_account_id, connect_charges_enabled, connect_details_submitted)
// — one account per org, shared across all the org's customers. No new table.
// We do NOT store or gate on connect_payouts_enabled: payouts being false just
// means the org's money sits in their Stripe balance until bank verification
// finishes; it does not block ACCEPTING a charge, so it must not hide the Pay
// button. (The old code gated on charges AND payouts and that over-strict gate
// is what made Pay Here silently never render.)
//
// `getStripe()` is imported from @/lib/billing (not redefined) so there is
// exactly one Stripe client factory, shared with SaaS-subscription billing.
//
// SQL/RLS/auth/security stay Claude-direct per [[lowvoltage-local-model-delegation]].

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/billing";

// ---------------------------------------------------------------------------
// The Stripe-Account header
// ---------------------------------------------------------------------------

/**
 * Request options that execute a call ON the org's connected account.
 *
 * Every Stripe object belonging to an org's customers — Customer, PaymentMethod,
 * Checkout Session, PaymentIntent, SetupIntent — must be created with these
 * options. An object created WITHOUT them silently lands in the platform
 * account instead, where it is both wrong and invisible to the org. When in
 * doubt, pass it.
 */
export function forAccount(stripeAccountId: string): Stripe.RequestOptions {
  return { stripeAccount: stripeAccountId };
}

// ---------------------------------------------------------------------------
// Connected-account row (on organizations)
// ---------------------------------------------------------------------------

export type ConnectAccount = {
  organizationId: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  /** Raw `controller.losses.payments` from Stripe: "stripe" | "application" |
   *  null when never refreshed. Stored raw rather than pre-interpreted so an
   *  audit can see exactly what Stripe reported. */
  lossesOwner: string | null;
  /** True when THIS PLATFORM absorbs the org's chargebacks. Derived — always
   *  read this rather than comparing lossesOwner by hand. */
  platformLiable: boolean;
};

/**
 * Who absorbs an unrecoverable loss (chargeback, refund past balance, fraud) on
 * a connected account, decided by `controller.losses.payments` at account
 * CREATION and immutable thereafter.
 *
 * createConnectedAccount() sets losses.payments = "stripe", so accounts minted
 * by current code are safe. Accounts created under the older Express
 * integration carry "application" — the platform is on the hook for those.
 *
 * FAILS CLOSED: null (never refreshed) counts as liable. An org whose status we
 * have not confirmed must not be able to take money on our risk.
 */
export function isPlatformLiable(lossesOwner: string | null): boolean {
  return lossesOwner !== "stripe";
}

const CONNECT_COLS =
  "id, stripe_connect_account_id, connect_charges_enabled, connect_details_submitted, connect_losses_owner";

/**
 * Read the org's connected-account flags (service role → bypasses RLS).
 * Null if the org has never started onboarding.
 */
export async function getConnectAccount(
  organizationId: string
): Promise<ConnectAccount | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("organizations")
    .select(CONNECT_COLS)
    .eq("id", organizationId)
    .maybeSingle();
  const id = (data?.stripe_connect_account_id as string | null) ?? null;
  if (!id) return null;
  return {
    organizationId: organizationId,
    stripeAccountId: id,
    chargesEnabled: !!data?.connect_charges_enabled,
    detailsSubmitted: !!data?.connect_details_submitted,
    lossesOwner: (data?.connect_losses_owner as string | null) ?? null,
    platformLiable: isPlatformLiable(
      (data?.connect_losses_owner as string | null) ?? null
    ),
  };
}

/** Resolve which org a connected account belongs to (webhook routing). */
export async function getOrgForStripeAccount(
  stripeAccountId: string
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("organizations")
    .select("id")
    .eq("stripe_connect_account_id", stripeAccountId)
    .maybeSingle();
  return (data?.id as string | null) ?? null;
}

// ---------------------------------------------------------------------------
// Connected account lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the org's connected account.
 *
 * ==== THE LIABILITY-CRITICAL CALL. Change nothing here casually. ====
 *
 * `controller` replaces the deprecated `type: "standard" | "express" | ...`
 * shorthand (Stripe deprecated the legacy account types; the controller
 * properties spell out what those types used to imply). This combination is the
 * Standard-account equivalent:
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
 *     customer's chargeback off our books. It is only permitted alongside
 *     direct charges; Stripe explicitly recommends against it for destination
 *     charges, which is another reason not to switch charge types.
 *
 *   fees.payer = "account"
 *     The org pays Stripe's processing fees directly out of their own volume.
 *     We are not in the fee chain at all → $0 Connect cost to the platform.
 *
 *   requirement_collection = "stripe"
 *     Stripe runs onboarding/verification and keeps it current as regulations
 *     change. We never collect, store, or become responsible for KYC data.
 *
 * Capabilities: card_payments is what direct charges actually need. transfers
 * is requested alongside because Stripe's onboarding treats the pair as the
 * normal merchant setup; it does NOT imply we will ever create a transfer, and
 * we don't.
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
  const { error } = await admin
    .from("organizations")
    .update({
      stripe_connect_account_id: account.id,
      // Cache the (almost certainly false) initial flags so the UI can render
      // without a per-load Stripe call before onboarding completes.
      connect_charges_enabled: account.charges_enabled ?? false,
      connect_details_submitted: account.details_submitted ?? false,
    })
    .eq("id", org.id);
  if (error) throw error;

  return account.id;
}

/**
 * A single-use Stripe-hosted onboarding URL.
 *
 * Account Links expire within minutes and are single-use by design — they grant
 * access to the account holder's personal information, so they must be handed to
 * an already-authenticated user in-app and never emailed or texted. The
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
    refresh_url: `${origin}/admin/billing?connect=refresh`,
    return_url: `${origin}/admin/billing?connect=return`,
    type: "account_onboarding",
  });
  if (!link.url) throw new Error("Stripe returned an account link with no URL");
  return link.url;
}

/**
 * Re-read the account from Stripe and persist the capability flags.
 *
 * Called on return from onboarding and from `account.updated` webhooks. The
 * stored flags are a CACHE for rendering (the public invoice view shows/hides
 * the Pay button from them without a Stripe call per load); this is the only
 * thing that refreshes them. Returning to return_url does NOT mean onboarding
 * completed — Stripe is explicit that it only means the flow was entered and
 * exited — so the UI must read charges_enabled from here, not assume success.
 */
export async function refreshConnectAccount(
  organizationId: string
): Promise<ConnectAccount | null> {
  const row = await getConnectAccount(organizationId);
  if (!row) return null;

  const stripe = await getStripe();
  const account = await stripe.accounts.retrieve(row.stripeAccountId);

  const chargesEnabled = !!account.charges_enabled;
  const detailsSubmitted = !!account.details_submitted;
  // Already on the object we just retrieved — costs no extra API call. Cached
  // so the charge guard and the office UI can decide without hitting Stripe.
  const lossesOwner = account.controller?.losses?.payments ?? null;

  const admin = createAdminClient();
  const { error } = await admin
    .from("organizations")
    .update({
      connect_charges_enabled: chargesEnabled,
      connect_details_submitted: detailsSubmitted,
      connect_losses_owner: lossesOwner,
    })
    .eq("id", organizationId);
  if (error) throw error;

  return {
    organizationId,
    stripeAccountId: row.stripeAccountId,
    chargesEnabled,
    detailsSubmitted,
    lossesOwner,
    platformLiable: isPlatformLiable(lossesOwner),
  };
}

/**
 * The org's connected account, guaranteed able to accept charges.
 *
 * Every charge path funnels through this rather than reading the row directly,
 * so "we tried to charge on a half-onboarded account" is one failure with one
 * clear message instead of an opaque Stripe error surfacing from many sites.
 */
export async function requireChargeableAccount(
  organizationId: string
): Promise<ConnectAccount> {
  const row = await getConnectAccount(organizationId);
  if (!row) {
    throw new Error(
      "This business hasn't set up online payments yet"
    );
  }
  if (!row.chargesEnabled) {
    throw new Error(
      "This business hasn't finished verifying its account for online payments yet"
    );
  }
  // LIABILITY GATE. An account whose losses fall on the platform must never be
  // charged on — accepting money there means accepting its chargebacks onto our
  // balance. Enforced HERE rather than at each call site because all three
  // money paths (invoice checkout, save-card setup, off-session auto-charge)
  // already funnel through this function, so there is exactly one place to get
  // it right and no way to bypass it by adding a fourth path later.
  //
  // Not repairable in place: controller.losses.payments is immutable after
  // account creation, so the fix is re-onboarding under current code, which
  // mints losses.payments = "stripe".
  if (row.platformLiable) {
    throw new Error(
      "Online payments are disabled for this business. Its Stripe account was " +
        "connected under our previous setup and would place chargeback " +
        "liability on the platform. Reconnect the account to enable payments."
    );
  }
  return row;
}