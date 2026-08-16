// Online invoice payments via Stripe Connect — server-only, security core.
//
// A customer pays the balance due on the public invoice view (/invoices/view/
// {token}) by clicking Pay Here. The checkout session is created on the
// PLATFORM account (STRIPE_SECRET_KEY) with transfer_data.destination = the
// org's CONNECTED Stripe account, so the funds (minus an optional platform fee)
// land in the org's account. The checkout.session.completed event fires on the
// platform account, so the existing /api/stripe/webhook handles it (branch on
// session.mode === "payment").
//
// The share_token is the ONLY credential on the public path — the amount is
// always computed server-side from the invoice's line items; a client can never
// dictate what to charge. The org must have a connected, charges-enabled Stripe
// account or no session is created (the public invoice view then shows no Pay
// button). The webhook records payment idempotently (billing_events.stripe_event_id
// + an invoice-level already-paid guard) and stamps the Stripe ids for audit.

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/billing";
import { computeTotal } from "@/lib/money";

// ── Connected-account lookup ───────────────────────────────────────────────
export async function getConnectAccount(
  orgId: string
): Promise<{ connectAccountId: string | null; chargesEnabled: boolean }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("organizations")
    .select("stripe_connect_account_id, connect_charges_enabled")
    .eq("id", orgId)
    .maybeSingle();
  return {
    connectAccountId: (data?.stripe_connect_account_id as string) ?? null,
    chargesEnabled: !!data?.connect_charges_enabled,
  };
}

// ── Create a Stripe Checkout session for the invoice balance (destination charge) ─
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

  // Org must have a connected, charges-enabled Stripe account.
  const { connectAccountId, chargesEnabled } = await getConnectAccount(
    invoice.organization_id
  );
  if (!connectAccountId)
    throw new Error("This business hasn't set up online payments yet");
  if (!chargesEnabled)
    throw new Error("This business hasn't finished setting up online payments yet");

  const customer = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const jobName =
    (invoice.jobs as unknown as { name: string } | null)?.name ?? "your project";
  const customerEmail = customer?.contact_email?.trim() || null;
  const amountCents = Math.round(balanceDue * 100);

  // Optional platform fee (env-gated, default none — org keeps 100%).
  const feePct = Number(process.env.STRIPE_PLATFORM_FEE_PERCENT) || 0;
  const feeCents = feePct > 0 ? Math.round(amountCents * (feePct / 100)) : 0;

  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
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
    // Destination charge: the customer pays the platform account, Stripe routes
    // the funds (minus an optional platform fee) to the org's connected account.
    // Both transfer_data + application_fee_amount live inside payment_intent_data
    // for Checkout payment-mode sessions.
    payment_intent_data: {
      metadata: { invoice_id: invoice.id, organization_id: invoice.organization_id },
      transfer_data: { destination: connectAccountId },
      ...(feeCents > 0 ? { application_fee_amount: feeCents } : {}),
    },
    metadata: { invoice_id: invoice.id, organization_id: invoice.organization_id },
    customer_email: customerEmail ?? undefined,
    success_url: `${input.origin}/invoices/view/${input.token}?paid=1`,
    cancel_url: `${input.origin}/invoices/view/${input.token}?canceled=1`,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}

// ── Record a completed payment on the invoice (called from the webhook) ─────
// Idempotent: billing_events.stripe_event_id already stops a redelivered event,
// and the already-paid guard here is a second line. Verifies the invoice's org
// matches the metadata (defensive — only the server ever sets metadata).
export async function applyInvoicePayment(
  session: Stripe.Checkout.Session
): Promise<void> {
  const invoiceId = session.metadata?.invoice_id;
  const metaOrgId = session.metadata?.organization_id;
  if (!invoiceId) return; // not an invoice-payment session

  const admin = createAdminClient();
  const { data: invoice } = await admin
    .from("invoices")
    .select("id, status, organization_id, amount_paid")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return;
  if (invoice.organization_id !== metaOrgId) return; // metadata/org mismatch — ignore

  if (invoice.status === "paid") return; // already applied (idempotent)

  // Recompute the invoice total from its line items to know if it's now paid.
  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("quantity, unit_price")
    .eq("invoice_id", invoiceId);
  const total = computeTotal(
    (lineItems ?? []).map((i) => ({
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
    }))
  );

  const paidAmount = Number(session.amount_total ?? 0) / 100;
  const prevPaid = Number(invoice.amount_paid ?? 0) || 0;
  const newAmountPaid = Math.min(prevPaid + paidAmount, total);

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  const update: Record<string, unknown> = {
    amount_paid: newAmountPaid,
    stripe_checkout_session_id: session.id,
    ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
  };
  if (newAmountPaid >= total) {
    update.status = "paid";
    update.paid_at = new Date().toISOString();
  }

  await admin.from("invoices").update(update).eq("id", invoiceId);
}