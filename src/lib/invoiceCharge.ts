// Card-on-file helpers for Stripe Connect DIRECT charges — server-only.
// Pairs with invoicePay.ts: invoicePay charges a card; this file manages the
// saved card itself (the per-customer Stripe Customer + PaymentMethod on the
// org's connected account). See connectAccount.ts for the liability argument
// (direct charges, org is merchant of record, platform not liable).
//
// Two ways a card gets saved:
//   1. Pay an invoice — invoicePay's checkout sets setup_future_usage=
//      "off_session", so paying also saves the card (applyInvoicePayment calls
//      stampCustomerCard).
//   2. "Save card for auto-pay" — createSaveCardCheckoutSession makes a
//      mode="setup" Checkout (no charge); the setup_intent.succeeded webhook
//      calls saveCardForCustomer → stampCustomerCard.
//
// The Stripe Customer + PaymentMethod live ON the org's connected account
// (direct charges), so customers.stripe_customer_id / stripe_payment_method_id
// are connected-account-scoped ids.

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/billing";
import { forAccount, requireChargeableAccount } from "@/lib/connectAccount";

// ── Resolve (creating if needed) the customer's Stripe Customer on the org's
//    connected account. Reuse matters: the Customer holds the saved card, so a
//    second Customer for someone who already has one orphans their payment
//    method (surfaces later as an inexplicable auto-charge failure).
export async function ensureStripeCustomer(
  customer: {
    id: string;
    name: string | null;
    contact_email: string | null;
    phone: string | null;
  },
  stripeAccountId: string
): Promise<string> {
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("customers")
    .select("stripe_customer_id")
    .eq("id", customer.id)
    .maybeSingle();
  const existing = (row?.stripe_customer_id as string | null) ?? null;
  if (existing) return existing;

  const stripe = await getStripe();
  const created = await stripe.customers.create(
    {
      name: customer.name ?? undefined,
      ...(customer.contact_email ? { email: customer.contact_email } : {}),
      ...(customer.phone ? { phone: customer.phone } : {}),
      metadata: { app_customer_id: customer.id },
    },
    forAccount(stripeAccountId)
  );

  await admin
    .from("customers")
    .update({ stripe_customer_id: created.id })
    .eq("id", customer.id);
  return created.id;
}

// ── Stamp a saved card onto the customer row for display + future auto-charge.
//    Retrieves the PaymentMethod on the connected account to read card details.
export async function stampCustomerCard(
  customerId: string,
  stripeAccountId: string,
  paymentMethodId: string
): Promise<void> {
  const stripe = await getStripe();
  const pm = await stripe.paymentMethods.retrieve(
    paymentMethodId,
    undefined,
    forAccount(stripeAccountId)
  );
  const card = pm.card;
  if (!card) return; // not a card PaymentMethod (e.g. bank debit) — skip

  const admin = createAdminClient();
  await admin
    .from("customers")
    .update({
      stripe_payment_method_id: pm.id,
      // Keep stripe_customer_id in sync if the PM carries a customer.
      ...(pm.customer && typeof pm.customer === "string"
        ? { stripe_customer_id: pm.customer }
        : {}),
      stripe_card_brand: card.brand,
      stripe_card_last4: card.last4,
      stripe_card_exp_month: card.exp_month,
      stripe_card_exp_year: card.exp_year,
    })
    .eq("id", customerId);
}

// ── "Save card for auto-pay" checkout (mode=setup, no charge). Public — the
//    share_token is the only credential (same as the Pay path). The customer
//    who opens an invoice can enroll in auto-pay without paying right now.
export async function createSaveCardCheckoutSession(input: {
  token: string;
  origin: string;
}): Promise<{ url: string }> {
  const admin = createAdminClient();

  const { data: invoice } = await admin
    .from("invoices")
    .select("id, status, organization_id, customer_id, customers(name, contact_email, phone)")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!invoice) throw new Error("Invoice not found");
  const customerId = (invoice.customer_id as string | null) ?? null;
  if (!customerId) throw new Error("No customer on this invoice");

  const account = await requireChargeableAccount(invoice.organization_id);

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const stripeCustomerId = await ensureStripeCustomer(
    {
      id: customerId,
      name: customer?.name ?? null,
      contact_email: customer?.contact_email ?? null,
      phone: customer?.phone ?? null,
    },
    account.stripeAccountId
  );

  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: stripeCustomerId,
      // off_session so the saved card can be charged without the customer
      // present (cycle billing). Stripe will only collect cards that support it.
      // (`usage` is a real Stripe API field but isn't on this SDK version's
      // SetupIntentData type, hence the cast — it ships to Stripe verbatim.)
      setup_intent_data: {
        usage: "off_session",
        // enroll_autopay marks THIS setup as the customer's explicit consent to
        // automatic charging (Phase 2c). The setup_intent.succeeded webhook sets
        // customers.autopay_enabled = true ONLY when this flag is present — so a
        // plain card-save (or a future non-consent path) never silently opts a
        // customer into autopay. Paying an invoice (mode=payment) saves the card
        // via setup_future_usage but fires payment_intent.succeeded, not
        // setup_intent.succeeded, so it never sets this flag either.
        metadata: {
          customer_id: customerId,
          organization_id: invoice.organization_id,
          enroll_autopay: "true",
        },
      } as Stripe.Checkout.SessionCreateParams.SetupIntentData,
      metadata: {
        customer_id: customerId,
        organization_id: invoice.organization_id,
        enroll_autopay: "true",
      },
      success_url: `${input.origin}/invoices/view/${input.token}?card=1`,
      cancel_url: `${input.origin}/invoices/view/${input.token}?canceled=1`,
    },
    forAccount(account.stripeAccountId)
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}

// ── setup_intent.succeeded webhook handler — stamp the saved card.
export async function saveCardForCustomer(
  setupIntent: Stripe.SetupIntent,
  stripeAccountId: string
): Promise<void> {
  const customerId = setupIntent.metadata?.customer_id;
  if (!customerId) return;
  const paymentMethodId = setupIntent.payment_method;
  if (!paymentMethodId) return;
  const admin = createAdminClient();
  await stampCustomerCard(
    customerId,
    stripeAccountId,
    typeof paymentMethodId === "string" ? paymentMethodId : paymentMethodId.id
  );

  // Phase 2c: the customer's explicit consent (the "Save card for autopay"
  // Checkout flow, which is the only path that sets enroll_autopay metadata)
  // enables autopay here. NOT a silent side effect of every card save — paying
  // an invoice saves the card via a PaymentIntent (no enroll_autopay metadata)
  // and leaves autopay off; the customer turns it on explicitly.
  if (setupIntent.metadata?.enroll_autopay === "true") {
    await admin
      .from("customers")
      .update({ autopay_enabled: true })
      .eq("id", customerId);
  }
}