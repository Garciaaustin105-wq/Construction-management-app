// Online invoice payments via Stripe Connect DIRECT charges — server-only,
// security core. A customer pays the balance due on the public invoice view
// (/invoices/view/{token}) by clicking Pay; the checkout session is created ON
// the org's connected account (the Stripe-Account header via forAccount()), so
// the charge lives on the ORG's balance — the org is merchant of record, the
// platform is never liable and takes no cut. See connectAccount.ts for the
// liability argument and the invariants (never transfer_data /
// application_fee_amount / on_behalf_of).
//
// The share_token is the ONLY credential on the public path — the amount is
// always computed server-side from the invoice's line items; a client can never
// dictate what to charge. The org must have a connected, charges-enabled
// Stripe account or no session is created (the public invoice view then shows
// no Pay button). The Connect webhook records payment idempotently
// (billing_events.stripe_event_id + an invoice-level already-paid guard) and
// stamps the Stripe ids for audit.
//
// The Pay checkout sets payment_intent_data.setup_future_usage = "off_session"
// + passes the customer's Stripe Customer (on the connected account), so paying
// an invoice ALSO saves the card for future off-session auto-charge — the
// customer is enrolled in auto-pay by paying once. A separate mode="setup"
// flow (invoiceCharge.ts) saves a card without charging, for customers who want
// to enroll between invoices.
//
// chargeInvoiceOffSession is the cycle-billing auto-charge: it creates an
// off-session PaymentIntent on the connected account using the customer's saved
// card, records the payment INLINE (synchronous, so the invoice is marked paid
// before the delivery email goes out — no race with the webhook), and returns
// whether it succeeded. The webhook's payment_intent.succeeded is then an
// idempotent no-op (already-paid guard).

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/billing";
import { computeTotal } from "@/lib/money";

// Local cents-rounding (money.ts keeps its own copy module-private; the manual
// payments route and estimateInvoice each do the same). Guards against
// float drift when summing two 2-decimal values, e.g. 999.99 + 0.01.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
import {
  forAccount,
  requireChargeableAccount,
} from "@/lib/connectAccount";
import { ensureStripeCustomer, stampCustomerCard } from "@/lib/invoiceCharge";

// ── Create a Stripe Checkout session for the invoice balance (DIRECT charge) ─
export async function createInvoiceCheckoutSession(input: {
  token: string;
  origin: string;
}): Promise<{ url: string }> {
  const admin = createAdminClient();

  // Token is the only credential — look the invoice up by share_token.
  const { data: invoice } = await admin
    .from("invoices")
    .select(
      "id, status, organization_id, customer_id, amount_paid, jobs(name), customers(name, contact_email, phone)"
    )
    .eq("share_token", input.token)
    .maybeSingle();
  if (!invoice) throw new Error("Invoice not found");

  if (invoice.status === "paid") throw new Error("This invoice is already paid");
  if (invoice.status === "void")
    throw new Error("This invoice has been voided and can't be paid online");

  // Total from line items — never trust a client amount.
  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", invoice.id);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );
  const amountPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - amountPaid);
  if (balanceDue <= 0) throw new Error("This invoice has no balance due");

  // Org must have a charges-enabled connected account. We gate on
  // charges_enabled ONLY (not payouts_enabled) — see connectAccount.ts header.
  const account = await requireChargeableAccount(invoice.organization_id);

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const jobName =
    (invoice.jobs as unknown as { name: string } | null)?.name ?? "your project";
  const customerEmail = customer?.contact_email?.trim() || null;
  const amountCents = Math.round(balanceDue * 100);

  // Resolve (creating if needed) the customer's Stripe Customer ON the org's
  // connected account, so the charge is associated with their record AND the
  // card is saved to it for future auto-charge.
  const stripeCustomerId = await ensureStripeCustomer(
    {
      id: invoice.customer_id as string,
      name: customer?.name ?? null,
      contact_email: customerEmail,
      phone: customer?.phone ?? null,
    },
    account.stripeAccountId
  );

  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer: stripeCustomerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: `Invoice — ${jobName}` },
          },
        },
      ],
      // DIRECT charge: created on the connected account via the Stripe-Account
      // header (forAccount). NO transfer_data, NO application_fee_amount — the
      // org is merchant of record and keeps 100%. setup_future_usage = off_session
      // saves the card to the customer for future off-session auto-charge.
      payment_intent_data: {
        metadata: {
          invoice_id: invoice.id,
          organization_id: invoice.organization_id,
        },
        setup_future_usage: "off_session",
      },
      metadata: {
        invoice_id: invoice.id,
        organization_id: invoice.organization_id,
      },
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      success_url: `${input.origin}/invoices/view/${input.token}?paid=1`,
      cancel_url: `${input.origin}/invoices/view/${input.token}?canceled=1`,
    },
    forAccount(account.stripeAccountId)
  );
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}

// ── Record a completed payment on the invoice (shared idempotent core) ──────
// Called from both the Checkout path (checkout.session.completed) and the
// off-session auto-charge path (payment_intent.succeeded / inline). Idempotent:
// the webhook's billing_events.stripe_event_id dedup is the first line; the
// already-paid guard here is the second. Verifies the invoice's org matches the
// metadata (defensive — only the server ever sets metadata).
export async function recordInvoicePayment(input: {
  invoiceId: string;
  orgId: string;
  paidAmountCents: number;
  paymentIntentId: string | null;
  checkoutSessionId?: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: invoice } = await admin
    .from("invoices")
    .select("id, status, organization_id, amount_paid, jobs(name), customers(name)")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (!invoice) return;
  if (invoice.organization_id !== input.orgId) return; // metadata/org mismatch
  if (invoice.status === "paid") return; // already applied (idempotent)

  // Recompute the invoice total from its line items to know if it's now paid.
  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", input.invoiceId);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );

  const paidAmount = input.paidAmountCents / 100;

  // OPTIMISTIC CONCURRENCY. This previously did a plain read-then-write, which
  // lost money under concurrency: a card payment and an office-recorded check
  // could both read amount_paid=0, and whichever wrote last overwrote the
  // other. The manual path (api/invoices/[id]/payments) already guarded this;
  // the Stripe path — which actually runs concurrently from webhook retries —
  // did not. Same pattern as applyPaymentToInvoice() there: write with
  // .eq("amount_paid", <value just read>) so the update only lands if nothing
  // changed underneath, and on a 0-row match re-read and re-accumulate onto
  // the FRESH value. (invoices.amount_paid is numeric(12,2) not null default 0,
  // so a plain .eq comparison is safe.)
  const MAX_ATTEMPTS = 5;
  let newAmountPaid = 0;
  let settled = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: fresh } = await admin
      .from("invoices")
      .select("amount_paid, status")
      .eq("id", input.invoiceId)
      .maybeSingle();
    if (!fresh) return;
    // Re-check inside the loop: a concurrent delivery may have settled it
    // between our first read and this attempt.
    if ((fresh as { status: string }).status === "paid") return;

    const priorAmountPaidRaw = (fresh as { amount_paid: number | string })
      .amount_paid;
    const prevPaid = Number(priorAmountPaidRaw ?? 0) || 0;
    // Record the FULL amount received. This was Math.min(prevPaid + paidAmount,
    // total), which silently discarded any overpayment: Stripe took the money
    // and the app's record simply lost it — no credit, no flag, no notification
    // (billing handoff Finding 3).
    //
    // Uncapped matches what the MANUAL office path
    // (api/invoices/[id]/payments) has always done, so the two payment paths
    // now agree instead of disagreeing. amount_paid > total is a state the app
    // already handles: every consumer clamps the derived balance with
    // Math.max(0, total - amountPaid) — see invoicePay (x2), emailLoaders and
    // insights.overdueBalance.
    newAmountPaid = round2(prevPaid + paidAmount);

    const update: Record<string, unknown> = {
      amount_paid: newAmountPaid,
      ...(input.checkoutSessionId
        ? { stripe_checkout_session_id: input.checkoutSessionId }
        : {}),
      ...(input.paymentIntentId
        ? { stripe_payment_intent_id: input.paymentIntentId }
        : {}),
    };
    if (newAmountPaid >= total) {
      update.status = "paid";
      update.paid_at = new Date().toISOString();
    }

    const { data: updated, error: updErr } = await admin
      .from("invoices")
      .update(update)
      .eq("id", input.invoiceId)
      .eq("amount_paid", priorAmountPaidRaw)
      .select("id")
      .maybeSingle();

    if (updErr) return; // surfaced by the webhook's catch; Stripe will retry
    if (updated) {
      settled = true;
      break;
    }
    // else: amount_paid moved under us — loop and retry against the fresh value.
  }

  if (!settled) {
    // Exhausted retries under heavy concurrency. Throw so the webhook marks the
    // claim failed and Stripe retries — better than silently dropping a payment.
    throw new Error(
      `Could not apply payment to invoice ${input.invoiceId} after ${MAX_ATTEMPTS} attempts (concurrent updates).`
    );
  }

  // Record an in-app "invoice paid" notification for the office feed ONLY when
  // the payment fully settled the invoice. Service role (bypasses RLS).
  // Non-fatal: the invoice is already marked paid by the time this runs, so a
  // DB hiccup must never throw back up to the webhook. The unique
  // (type, entity_id) index makes a redelivered webhook a no-op.
  if (newAmountPaid >= total) {
    try {
      const customerName =
        (invoice.customers as unknown as { name: string | null } | null)?.name ??
        "";
      const jobName =
        (invoice.jobs as unknown as { name: string } | null)?.name ?? "";
      const body = [customerName, jobName, `$${paidAmount.toFixed(2)}`]
        .filter(Boolean)
        .join(" · ");
      await admin.from("notifications").insert({
        organization_id: invoice.organization_id,
        type: "invoice_paid",
        title: "Invoice paid",
        body,
        href: `/invoices/${input.invoiceId}`,
        entity_id: input.invoiceId,
      });
    } catch {
      // Swallow — feed is best-effort; payment already recorded.
    }
  }

  // OVERPAYMENT. The customer paid more than the invoice total. amount_paid now
  // carries the true figure (see the uncapped sum above), but the office would
  // otherwise have no idea — they'd only find it by reconciling against Stripe
  // by hand. Surface it so a refund or credit can be issued deliberately.
  //
  // This does NOT create a credit balance; that is a bigger product change.
  // Best-effort + non-fatal like the paid notification, and deduped by the
  // unique (type, entity_id) index so a redelivered webhook is a no-op.
  const overpaid = total > 0 ? round2(newAmountPaid - total) : 0;
  if (overpaid > 0) {
    try {
      const customerName =
        (invoice.customers as unknown as { name: string | null } | null)?.name ??
        "";
      await admin.from("notifications").insert({
        organization_id: invoice.organization_id,
        type: "invoice_overpaid",
        title: "Invoice overpaid",
        body: [customerName, `overpaid by $${overpaid.toFixed(2)}`]
          .filter(Boolean)
          .join(" · "),
        href: `/invoices/${input.invoiceId}`,
        entity_id: input.invoiceId,
      });
    } catch {
      // Swallow — feed is best-effort; the payment + true amount_paid are saved.
    }
  }
}

// ── checkout.session.completed (mode=payment) ───────────────────────────────
// Records the payment AND, because the Pay checkout saves the card
// (setup_future_usage=off_session), stamps the customer's saved card for
// future auto-charge.
export async function applyInvoicePayment(
  session: Stripe.Checkout.Session,
  stripeAccountId: string
): Promise<void> {
  const invoiceId = session.metadata?.invoice_id;
  const orgId = session.metadata?.organization_id;
  if (!invoiceId || !orgId) return; // not an invoice-payment session

  await recordInvoicePayment({
    invoiceId,
    orgId,
    paidAmountCents: Number(session.amount_total ?? 0),
    paymentIntentId:
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null,
    checkoutSessionId: session.id,
  });

  // Stamp the saved card (the Pay checkout enrolled this customer in auto-pay).
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
  if (paymentIntentId) {
    try {
      const stripe = await getStripe();
      const pi = await stripe.paymentIntents.retrieve(
        paymentIntentId,
        undefined,
        forAccount(stripeAccountId)
      );
      if (pi.payment_method) {
        const admin = createAdminClient();
        const { data: inv } = await admin
          .from("invoices")
          .select("customer_id")
          .eq("id", invoiceId)
          .maybeSingle();
        const customerId = (inv?.customer_id as string | null) ?? null;
        if (customerId) {
          await stampCustomerCard(
            customerId,
            stripeAccountId,
            typeof pi.payment_method === "string"
              ? pi.payment_method
              : pi.payment_method.id
          );
        }
      }
    } catch {
      // Swallow — the payment is already recorded; card-stamping is best-effort.
    }
  }
}

// ── payment_intent.succeeded (off-session auto-charge path) ─────────────────
export async function applyInvoicePaymentFromPI(
  pi: Stripe.PaymentIntent
): Promise<void> {
  const invoiceId = pi.metadata?.invoice_id;
  const orgId = pi.metadata?.organization_id;
  if (!invoiceId || !orgId) return;
  await recordInvoicePayment({
    invoiceId,
    orgId,
    paidAmountCents: pi.amount,
    paymentIntentId: pi.id,
  });
}

// ── Declined autopay: record retry state + tell the office ──────────────────
// Called ONLY when a charge was actually attempted and failed (Stripe error or
// a declined/requires-action PaymentIntent) — never for the benign "no saved
// card / autopay off / no balance" skips. Stamps the invoice's retry state so
// the retry cron (/api/lawn/cron/retry-autopay) picks it back up after
// RETRY_IN_DAYS, up to MAX_AUTOPAY_ATTEMPTS total, and drops one office-feed
// notification (deduped by the unique (type, entity_id) index, same pattern as
// recordInvoicePayment's invoice_paid). All best-effort + non-fatal: the
// invoice itself was billed fine and still delivers for manual payment.
const MAX_AUTOPAY_ATTEMPTS = 3;
const AUTOPAY_RETRY_IN_DAYS = 3;

async function recordAutopayFailure(
  invoiceId: string,
  orgId: string,
  reason: string
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: inv } = await admin
      .from("invoices")
      .select("autopay_attempts, customers(name), jobs(name)")
      .eq("id", invoiceId)
      .maybeSingle();

    const attempts = Math.min(
      MAX_AUTOPAY_ATTEMPTS,
      ((inv as { autopay_attempts?: number } | null)?.autopay_attempts ?? 0) + 1
    );
    const nextRetry = new Date();
    nextRetry.setUTCDate(nextRetry.getUTCDate() + AUTOPAY_RETRY_IN_DAYS);
    await admin
      .from("invoices")
      .update({
        autopay_attempts: attempts,
        autopay_last_error: reason.slice(0, 500),
        // Past the final attempt: stop scheduling retries (the customer pays
        // manually or the office collects); the error text stays for the office.
        autopay_next_retry_at:
          attempts >= MAX_AUTOPAY_ATTEMPTS ? null : nextRetry.toISOString(),
      })
      .eq("id", invoiceId);

    const customerName =
      (inv as unknown as { customers?: { name: string | null } } | null)
        ?.customers?.name ?? "";
    const jobName =
      (inv as unknown as { jobs?: { name: string } } | null)?.jobs?.name ?? "";
    await admin.from("notifications").insert({
      organization_id: orgId,
      type: "autopay_declined",
      title: "Autopay charge declined",
      body: [customerName, jobName, `attempt ${attempts}/${MAX_AUTOPAY_ATTEMPTS}`, reason]
        .filter(Boolean)
        .join(" · "),
      href: `/invoices/${invoiceId}`,
      entity_id: invoiceId,
    });
  } catch {
    // Swallow — retry state + feed are best-effort; delivery already ran.
  }
}

// ── Off-session auto-charge for cycle billing ────────────────────────────────
// Creates an off-session PaymentIntent on the connected account using the
// customer's saved card. On success, records the payment INLINE (synchronous —
// the invoice is marked paid before the delivery email goes out, so there is no
// race with the webhook; the later payment_intent.succeeded webhook is an
// idempotent no-op via the already-paid guard). Returns whether it succeeded +
// a reason when it didn't, so the caller (lawnBilling.ts) can decide whether to
// still deliver the invoice for manual payment.
export async function chargeInvoiceOffSession(input: {
  invoiceId: string;
}): Promise<{ charged: boolean; reason?: string }> {
  const admin = createAdminClient();

  const { data: invoice } = await admin
    .from("invoices")
    .select("id, status, organization_id, customer_id, amount_paid")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (!invoice) return { charged: false, reason: "Invoice not found" };
  if (invoice.status === "paid")
    return { charged: false, reason: "already paid" };
  const customerId = (invoice.customer_id as string | null) ?? null;
  if (!customerId) return { charged: false, reason: "no customer on invoice" };

  // Customer row: consent flag + saved card (on the org's connected account).
  // autopay_enabled is the Phase-2 consent gate — it MUST be checked before any
  // card is charged. Without it, exposing save-card would auto-charge every
  // customer forever with no opt-out (the sequencing hazard in
  // docs/handoff-lawn-autopay-phase2.md). A falsy result leaves the invoice
  // `sent` (the try/catch in lawnBilling.ts), so normal delivery still runs.
  const { data: customer } = await admin
    .from("customers")
    .select("stripe_customer_id, stripe_payment_method_id, autopay_enabled")
    .eq("id", customerId)
    .maybeSingle();
  if (!customer?.autopay_enabled)
    return { charged: false, reason: "autopay not enabled" };
  const stripeCustomerId = (customer?.stripe_customer_id as string | null) ?? null;
  const paymentMethodId =
    (customer?.stripe_payment_method_id as string | null) ?? null;
  if (!stripeCustomerId || !paymentMethodId)
    return { charged: false, reason: "no saved card" };

  // Chargeable connected account.
  let account;
  try {
    account = await requireChargeableAccount(invoice.organization_id);
  } catch (err) {
    return {
      charged: false,
      reason: err instanceof Error ? err.message : "online payments not set up",
    };
  }

  // Amount = balance due (server-side from line items; never trust a stored copy).
  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", input.invoiceId);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );
  const prevPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - prevPaid);
  if (balanceDue <= 0) return { charged: false, reason: "no balance due" };
  const amountCents = Math.round(balanceDue * 100);

  const stripe = await getStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          invoice_id: input.invoiceId,
          organization_id: invoice.organization_id,
        },
      },
      forAccount(account.stripeAccountId)
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : "charge failed";
    await recordAutopayFailure(input.invoiceId, invoice.organization_id, reason);
    return { charged: false, reason };
  }

  if (pi.status === "succeeded") {
    // Record inline so the invoice is paid before delivery. The webhook no-ops.
    await recordInvoicePayment({
      invoiceId: input.invoiceId,
      orgId: invoice.organization_id,
      paidAmountCents: amountCents,
      paymentIntentId: pi.id,
    });
    return { charged: true };
  }

  // requires_action = the card needs authentication that off-session can't
  // provide; requires_payment_method / canceled = declined. Either way the
  // customer must pay manually via the Pay button.
  const reason =
    pi.status === "requires_action"
      ? "card requires authentication — can't auto-charge"
      : pi.last_payment_error?.message ?? `charge ${pi.status}`;
  await recordAutopayFailure(input.invoiceId, invoice.organization_id, reason);
  return { charged: false, reason };
}