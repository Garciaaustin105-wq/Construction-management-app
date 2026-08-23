// Server-only: ISP subscriber enrollment, Stripe→app state sync, and the
// missed-payment dunning transitions.
//
// Every Stripe call here runs ON the org's connected account (see
// src/lib/ispBilling.ts::forAccount). Nothing in this file may create a charge,
// customer, price, or subscription on the platform account.
//
// ===========================================================================
// TWO STRIPE API SHAPE CHANGES THIS FILE WORKS AROUND (SDK 22 / OpenAPI v2349)
// ===========================================================================
// Both are silent runtime nulls if you write them the "old" way that most
// tutorials and older code still show. They are centralized in the two readers
// below so there is exactly one place to fix when they move again:
//
//   1. invoice.subscription        →  invoice.parent.subscription_details.subscription
//   2. subscription.current_period_end  →  subscription.items.data[i].current_period_end
//      (period is now per-ITEM; the subscription no longer carries one)
//
// If a renewal date starts coming back null, check these first.

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/billing";
import { sendCustomerEmail } from "@/lib/email";
import { pushInvoiceToAllConnectedProviders } from "@/lib/accounting/pushInvoice";
import {
  ensurePlanPrice,
  ensureStripeCustomer,
  forAccount,
  mapStripeStatus,
  requireChargeableAccount,
  type IspPlanRow,
  type IspSubStatus,
} from "@/lib/ispBilling";

// ---------------------------------------------------------------------------
// Version-shim readers (see header)
// ---------------------------------------------------------------------------

/** The subscription id an invoice belongs to, or null for a one-off invoice. */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const details = invoice.parent?.subscription_details;
  if (!details) return null;
  const sub = details.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

/**
 * A stable Stripe reference for the money movement behind a paid invoice.
 *
 * THIRD shape change (same family as the two in the header): `invoice
 * .payment_intent` is gone; payments are now a sub-list, and that list is only
 * populated when explicitly expanded — so in a raw webhook payload it is
 * usually absent entirely. Code that reads only the PaymentIntent therefore
 * gets null most of the time, and a null dedupe key means every redelivery
 * mirrors the invoice again.
 *
 * So: prefer the real PaymentIntent id when it happens to be there (it's the
 * more useful thing to reconcile against in Stripe), and otherwise fall back to
 * the invoice's own id — which is always present, unique, and one-per-payment
 * for our purposes. The column that stores this is named for the PaymentIntent
 * for historical reasons; treat it as "the Stripe object that produced this
 * row."
 */
export function invoicePaymentRef(invoice: Stripe.Invoice): string | null {
  for (const p of invoice.payments?.data ?? []) {
    const pi = p.payment?.payment_intent;
    if (typeof pi === "string") return pi;
    if (pi && typeof pi === "object") return pi.id;
  }
  return invoice.id ?? null;
}

/**
 * The subscription's current period end, as an ISO string.
 *
 * Read off the first subscription item because Stripe moved the billing period
 * onto items. Our plans are single-item by construction (one plan = one price),
 * so item[0] is the whole story; a multi-item subscription would need the max.
 */
export function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const ends = (sub.items?.data ?? [])
    .map((i) => i.current_period_end)
    .filter((n): n is number => typeof n === "number");
  if (ends.length === 0) return null;
  return new Date(Math.max(...ends) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export type EnrollResult = {
  subscriptionRowId: string;
  checkoutUrl: string;
};

/**
 * Put a customer onto a plan.
 *
 * Returns a Stripe Checkout URL rather than creating the Subscription outright,
 * because the subscriber has to enter a card and complete any SCA/3DS challenge
 * themselves. Creating a Subscription server-side without a payment method just
 * produces an `incomplete` subscription that dies 23 hours later — the failure
 * mode looks like "enrollment worked" right up until it silently doesn't.
 *
 * The Checkout Session is created ON the org's connected account, so the
 * customer sees the ORG's business name and branding on the payment page, and
 * the resulting charge settles in the ORG's balance. The app learns the outcome
 * from `customer.subscription.created` on the ISP webhook, not from the return
 * URL — the customer may close the tab before redirecting back.
 *
 * The local isp_subscriptions row is written FIRST, in status 'none'. That row
 * is what makes the webhook able to find this enrollment when it fires, and the
 * partial unique index on (customer_id) where status is live is what makes a
 * double-click return the existing enrollment instead of billing someone twice.
 */
export async function enrollCustomer(params: {
  orgId: string;
  customerId: string;
  planId: string;
  origin: string;
}): Promise<EnrollResult> {
  const { orgId, customerId, planId, origin } = params;
  const admin = createAdminClient();

  const account = await requireChargeableAccount(orgId);

  const { data: plan } = await admin
    .from("isp_plans")
    .select(
      "id, organization_id, name, price_cents, billing_interval, stripe_product_id, stripe_price_id"
    )
    .eq("id", planId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!plan) throw new Error("That plan no longer exists.");
  if (!(plan as IspPlanRow).price_cents) {
    throw new Error(
      `"${(plan as IspPlanRow).name}" has no price set. Set a monthly price before enrolling anyone on it.`
    );
  }

  const { data: customer } = await admin
    .from("customers")
    .select("id, name, contact_email, phone")
    .eq("id", customerId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!customer) throw new Error("That customer no longer exists.");

  // Reuse a live enrollment rather than creating a second one. The DB index
  // would reject the insert anyway; catching it here gives a real message.
  const { data: existing } = await admin
    .from("isp_subscriptions")
    .select("id, status, stripe_customer_id, stripe_subscription_id")
    .eq("customer_id", customerId)
    .in("status", ["none", "trialing", "active", "past_due", "suspended"])
    .maybeSingle();

  if (existing && existing.stripe_subscription_id) {
    throw new Error(
      `${customer.name} already has an active subscription. Cancel it before enrolling them on a different plan.`
    );
  }

  let subRowId = existing?.id as string | undefined;
  if (!subRowId) {
    const { data: inserted, error } = await admin
      .from("isp_subscriptions")
      .insert({
        organization_id: orgId,
        customer_id: customerId,
        plan_id: planId,
        status: "none",
      })
      .select("id, stripe_customer_id")
      .single();
    if (error) throw error;
    subRowId = inserted.id as string;
  }

  const priceId = await ensurePlanPrice(plan as IspPlanRow, account.stripe_account_id);

  const stripeCustomerId = await ensureStripeCustomer(
    {
      id: subRowId,
      stripe_customer_id:
        (existing?.stripe_customer_id as string | null | undefined) ?? null,
    },
    {
      id: customer.id as string,
      name: customer.name as string,
      contact_email: (customer.contact_email as string | null) ?? null,
      phone: (customer.phone as string | null) ?? null,
    },
    account.stripe_account_id
  );

  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/isp/checkout/complete?checkout=success`,
      cancel_url: `${origin}/isp/checkout/complete?checkout=canceled`,
      // Stamped so the webhook can tie the resulting subscription back to our
      // row without a lookup-by-customer heuristic.
      subscription_data: {
        metadata: {
          isp_subscription_row_id: subRowId,
          organization_id: orgId,
          app_customer_id: customer.id as string,
        },
      },
    },
    forAccount(account.stripe_account_id)
  );

  if (!session.url) throw new Error("Stripe returned a checkout session with no URL");
  return { subscriptionRowId: subRowId, checkoutUrl: session.url };
}

// ---------------------------------------------------------------------------
// Stripe → app sync
// ---------------------------------------------------------------------------

/** Locate our row for a Stripe subscription — by metadata first, then by id. */
async function findSubRow(
  orgId: string,
  sub: Stripe.Subscription
): Promise<{ id: string; status: IspSubStatus } | null> {
  const admin = createAdminClient();

  const stampedId = sub.metadata?.isp_subscription_row_id;
  if (stampedId) {
    const { data } = await admin
      .from("isp_subscriptions")
      .select("id, status")
      .eq("id", stampedId)
      .maybeSingle();
    if (data) return data as { id: string; status: IspSubStatus };
  }

  const { data } = await admin
    .from("isp_subscriptions")
    .select("id, status")
    .eq("organization_id", orgId)
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  return (data as { id: string; status: IspSubStatus } | null) ?? null;
}

/**
 * Apply a Stripe Subscription's state to our row.
 *
 * Note what is NOT touched here: grace_until and warned_at. Those belong to the
 * dunning lifecycle (below) and are cleared only on a real recovery, so a
 * routine `customer.subscription.updated` can't accidentally reset a running
 * grace clock and hand a non-paying subscriber another full 14 days.
 */
export async function syncFromStripeSubscription(
  orgId: string,
  sub: Stripe.Subscription
): Promise<void> {
  const admin = createAdminClient();
  const row = await findSubRow(orgId, sub);
  if (!row) return;

  const next = mapStripeStatus(sub.status, row.status);

  const patch: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    status: next,
    current_period_end: subscriptionPeriodEnd(sub),
  };
  if (typeof sub.customer === "string") patch.stripe_customer_id = sub.customer;
  if (sub.start_date) patch.started_at = new Date(sub.start_date * 1000).toISOString();
  if (next === "canceled") {
    patch.canceled_at = sub.canceled_at
      ? new Date(sub.canceled_at * 1000).toISOString()
      : new Date().toISOString();
    // A canceled subscription is no longer in dunning.
    patch.grace_until = null;
    patch.warned_at = null;
  }

  await admin.from("isp_subscriptions").update(patch).eq("id", row.id);
}

// ---------------------------------------------------------------------------
// Dunning: payment failed → warn → grace → (cron) suspend
// ---------------------------------------------------------------------------

/**
 * A subscriber's payment failed.
 *
 * Starts the grace clock ONCE per past-due episode. Stripe retries a failed
 * invoice several times over ~3 weeks and emits `invoice.payment_failed` on
 * every attempt; re-stamping grace_until on each of those would push the
 * suspension date forward forever and the subscriber would never actually be
 * cut off. So grace_until is only set when it is currently null.
 */
export async function handleInvoicePaymentFailed(
  orgId: string,
  invoice: Stripe.Invoice
): Promise<void> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return; // one-off invoice, not a plan renewal

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("isp_subscriptions")
    .select("id, status, grace_until, warned_at, customer_id")
    .eq("organization_id", orgId)
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  if (!row) return;

  // Already suspended: stay suspended. Nothing to re-warn about.
  if (row.status === "suspended") return;

  const { data: org } = await admin
    .from("organizations")
    .select("name, dunning_grace_days")
    .eq("id", orgId)
    .maybeSingle();
  const graceDays = (org?.dunning_grace_days as number | null) ?? 14;

  const patch: Record<string, unknown> = { status: "past_due" };
  if (!row.grace_until) {
    patch.grace_until = new Date(
      Date.now() + graceDays * 86_400_000
    ).toISOString();
  }

  await admin.from("isp_subscriptions").update(patch).eq("id", row.id);

  // Warn once per episode. warned_at is cleared on recovery, so a customer who
  // lapses again later does get warned again.
  if (!row.warned_at) {
    const graceUntil =
      (patch.grace_until as string | undefined) ??
      (row.grace_until as string | null) ??
      null;
    const sent = await sendDunningEmail({
      orgId,
      orgName: (org?.name as string | null) ?? null,
      customerId: row.customer_id as string,
      kind: "warning",
      graceUntil,
    });
    if (sent) {
      await admin
        .from("isp_subscriptions")
        .update({ warned_at: new Date().toISOString() })
        .eq("id", row.id);
    }
  }
}

/**
 * A subscriber's payment succeeded.
 *
 * Recovery clears the whole dunning state — status back to active, grace clock
 * and warning stamp reset so a future lapse starts clean. The suspension flag
 * on isp_customer_profiles follows automatically via the DB trigger.
 */
export async function handleInvoicePaid(
  orgId: string,
  invoice: Stripe.Invoice
): Promise<void> {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("isp_subscriptions")
    .select("id, status, customer_id")
    .eq("organization_id", orgId)
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  if (!row) return;

  const wasSuspended = row.status === "suspended";

  await admin
    .from("isp_subscriptions")
    .update({
      status: "active",
      grace_until: null,
      warned_at: null,
      suspended_at: null,
    })
    .eq("id", row.id);

  if (wasSuspended) {
    const { data: org } = await admin
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    await sendDunningEmail({
      orgId,
      orgName: (org?.name as string | null) ?? null,
      customerId: row.customer_id as string,
      kind: "restored",
      graceUntil: null,
    });
  }

  await recordPaidInvoice(orgId, row.customer_id as string, invoice);
}

// ---------------------------------------------------------------------------
// Internal invoice mirror + accounting push
// ---------------------------------------------------------------------------

/**
 * Mirror a paid Stripe invoice into the app's own `invoices` table and push it
 * to whatever bookkeeping providers the org has connected.
 *
 * WHY MIRROR AT ALL: Stripe already has the invoice, so this looks redundant.
 * It isn't — the app's reports, the customer's invoice history, and the QBO /
 * Xero / FreshBooks sync all read `invoices`. Without the mirror, ISP
 * subscription revenue is invisible everywhere except Stripe, and the org's
 * books silently understate income by exactly their recurring revenue.
 *
 * Idempotent on stripe_payment_intent_id: Stripe can deliver `invoice.paid`
 * more than once, and the webhook's event-id guard doesn't help across
 * DIFFERENT event ids describing the same payment.
 *
 * The accounting push is best-effort by design (it never throws — see
 * pushInvoiceToAllConnectedProviders), mirroring the proposal e-sign precedent:
 * a bookkeeping outage must not cause us to 500 at Stripe and trigger retries
 * of an already-applied payment.
 */
async function recordPaidInvoice(
  orgId: string,
  customerId: string,
  invoice: Stripe.Invoice
): Promise<void> {
  const admin = createAdminClient();

  const amountCents = invoice.amount_paid ?? 0;
  if (amountCents <= 0) return;

  const paymentRef = invoicePaymentRef(invoice);
  if (!paymentRef) return;

  const { data: already } = await admin
    .from("invoices")
    .select("id")
    .eq("organization_id", orgId)
    .eq("stripe_payment_intent_id", paymentRef)
    .maybeSingle();
  if (already) return;

  const paidAt = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
    : new Date().toISOString();

  const { data: created, error } = await admin
    .from("invoices")
    .insert({
      organization_id: orgId,
      customer_id: customerId,
      status: "paid",
      paid_at: paidAt,
      sent_at: paidAt,
      amount_paid: amountCents / 100,
      stripe_payment_intent_id: paymentRef,
    })
    .select("id")
    .single();
  if (error || !created) return;

  // `invoices` carries no total column — the total is the sum of its line
  // items, so the amount has to land here to be worth anything downstream.
  const description =
    invoice.lines?.data?.[0]?.description ?? "Internet service — monthly plan";
  await admin.from("invoice_line_items").insert({
    organization_id: orgId,
    invoice_id: created.id,
    description,
    quantity: 1,
    unit_price: amountCents / 100,
    position: 0,
  });

  try {
    await pushInvoiceToAllConnectedProviders(admin, orgId, created.id as string);
  } catch {
    // Never fatal — see the doc comment above.
  }
}

// ---------------------------------------------------------------------------
// Dunning email
// ---------------------------------------------------------------------------

type DunningKind = "warning" | "suspended" | "restored";

/**
 * Send a dunning notice to the subscriber, from the ORG (not the platform).
 *
 * Returns false when nothing was sent — no email on file, the customer opted
 * out, or Resend isn't configured. Callers use that to decide whether to stamp
 * warned_at, so an unconfigured mailer doesn't mark everyone as "warned" and
 * then suspend them without notice.
 */
export async function sendDunningEmail(params: {
  orgId: string;
  orgName: string | null;
  customerId: string;
  kind: DunningKind;
  graceUntil: string | null;
}): Promise<boolean> {
  const { orgName, customerId, kind, graceUntil } = params;
  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("name, contact_email, email_opt_in")
    .eq("id", customerId)
    .maybeSingle();

  const to = (customer?.contact_email as string | null)?.trim();
  if (!to) return false;
  if (customer?.email_opt_in === false) return false;

  const who = (customer?.name as string | null) ?? "there";
  const org = orgName?.trim() || "your internet provider";
  const deadline = graceUntil
    ? new Date(graceUntil).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;

  let subject: string;
  let body: string;

  if (kind === "warning") {
    subject = `Payment failed — action needed for your ${org} service`;
    body = [
      `Hi ${who},`,
      `We weren't able to process the payment for your internet service.`,
      deadline
        ? `Please update your payment method by ${deadline} to avoid an interruption in service.`
        : `Please update your payment method to avoid an interruption in service.`,
      `If you've already taken care of this, you can ignore this message.`,
      `— ${org}`,
    ].join("\n");
  } else if (kind === "suspended") {
    subject = `Your ${org} service has been suspended`;
    body = [
      `Hi ${who},`,
      `Your internet service has been suspended because we weren't able to process payment.`,
      `Update your payment method to restore service. Once payment goes through, your service will be reconnected.`,
      `— ${org}`,
    ].join("\n");
  } else {
    subject = `Your ${org} service has been restored`;
    body = [
      `Hi ${who},`,
      `Thanks — your payment went through and your internet service has been restored.`,
      `— ${org}`,
    ].join("\n");
  }

  const { error } = await sendCustomerEmail({ to, subject, body, orgName });
  return !error;
}
