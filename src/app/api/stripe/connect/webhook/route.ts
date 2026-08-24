import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgForStripeAccount, refreshConnectAccount } from "@/lib/connectAccount";
import { applyInvoicePayment, applyInvoicePaymentFromPI } from "@/lib/invoicePay";
import { saveCardForCustomer } from "@/lib/invoiceCharge";

// Stripe Connect webhook — customer-money events for DIRECT charges on the
// org's connected account. SEPARATE from /api/stripe/webhook (SaaS-subscription
// events) with its own signing secret (STRIPE_CONNECT_WEBHOOK_SECRET) so a bug
// in one path can't affect the other. Direct-charge Connect events arrive with
// event.account = the connected account id; we route by event type + that id.
//
// Must read the raw body (request.text()) to verify the signature. Idempotent
// via the billing_events.stripe_event_id unique key (shared with the SaaS
// webhook — Stripe event ids are globally unique). If a handler throws, return
// 500 WITHOUT recording the event so Stripe retries (all handlers are
// idempotent — re-applying is safe).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Connect webhook secret not configured" },
      { status: 500 }
    );
  }

  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = await getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: if we've already processed this event id, stop here.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("billing_events")
    .select("id")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  // The connected account this event belongs to (direct-charge events carry it).
  const stripeAccountId = event.account ?? null;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Only invoice-payment sessions (mode=payment) are ours; a mode=setup
        // session (save-card) fires checkout.session.completed too but carries
        // no invoice — its card save is handled by setup_intent.succeeded below.
        if (session.mode === "payment" && stripeAccountId) {
          await applyInvoicePayment(session, stripeAccountId);
        }
        break;
      }
      case "setup_intent.succeeded": {
        if (stripeAccountId) {
          await saveCardForCustomer(
            event.data.object as Stripe.SetupIntent,
            stripeAccountId
          );
        }
        break;
      }
      case "payment_intent.succeeded": {
        // Off-session auto-charge path. (chargeInvoiceOffSession already records
        // inline on success, so this is usually an idempotent no-op via the
        // already-paid guard — but it's the safety net for any async success.)
        await applyInvoicePaymentFromPI(event.data.object as Stripe.PaymentIntent);
        break;
      }
      case "payment_intent.payment_failed": {
        // No auto-dunning v1: leave the invoice "sent" (the customer still owes
        // it; it surfaces in Unpaid Invoices) and best-effort notify the office
        // with the decline reason. The auto-charge caller already saw the
        // synchronous failure; this is the async mirror.
        const pi = event.data.object as Stripe.PaymentIntent;
        const invoiceId = pi.metadata?.invoice_id;
        const orgId = pi.metadata?.organization_id;
        if (invoiceId && orgId) {
          try {
            const reason =
              pi.last_payment_error?.message ?? `charge ${pi.status}`;
            await admin.from("notifications").insert({
              organization_id: orgId,
              type: "invoice_payment_failed",
              title: "Auto-charge failed",
              body: `Invoice ${invoiceId} · ${reason}`,
              href: `/invoices/${invoiceId}`,
              entity_id: invoiceId,
            });
          } catch {
            // Swallow — best-effort; the invoice is still owed + visible.
          }
        }
        break;
      }
      case "account.updated": {
        // Re-cache the org's capability flags (onboarding completed, or account
        // got restricted) so the public invoice view shows/hides Pay correctly.
        if (stripeAccountId) {
          const orgId = await getOrgForStripeAccount(stripeAccountId);
          if (orgId) await refreshConnectAccount(orgId);
        }
        break;
      }
      default:
        // Not ours — ignore (the SaaS webhook handles subscription events).
        break;
    }
  } catch (err) {
    console.error("connect webhook handler failed:", err);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  // Record the event for audit. Ignore a unique-violation race (two concurrent
  // deliveries of the same event) — the handler already ran.
  let payload: unknown = null;
  try {
    payload = JSON.parse(JSON.stringify(event.data.object));
  } catch {
    payload = null;
  }
  try {
    await admin.from("billing_events").insert({
      stripe_event_id: event.id,
      event_type: event.type,
      payload,
    });
  } catch {
    // Duplicate insert from a race — safe to ignore.
  }

  return NextResponse.json({ received: true });
}