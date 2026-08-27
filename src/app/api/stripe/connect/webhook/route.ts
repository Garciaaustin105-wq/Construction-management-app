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

  // Idempotency: CLAIM the event before doing any work. This used to be a
  // SELECT-check, process, then INSERT — which only deduped the log row, not
  // the work: Stripe retries, two concurrent deliveries both passed the SELECT
  // (neither had inserted yet), BOTH applied the payment, and the losing INSERT
  // was silently swallowed. That is a real double-apply on customer money.
  // claim_billing_event() makes the unique index a true mutex. See the
  // billing_events_claim migration.
  const admin = createAdminClient();
  const { data: claim, error: claimError } = await admin.rpc(
    "claim_billing_event",
    { p_event_id: event.id, p_event_type: event.type }
  );

  if (claimError) {
    // Couldn't reach the claim table — do NOT process (exactly-once can't be
    // guaranteed). 500 so Stripe retries.
    console.error("connect webhook claim failed:", claimError);
    return NextResponse.json({ error: "Claim failed" }, { status: 500 });
  }
  if (claim === "duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }
  if (claim === "in_progress") {
    // Another worker holds a fresh claim; don't double-apply.
    return NextResponse.json({ received: true, inProgress: true });
  }
  // claim === "claimed" — this invocation owns the event.

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
    // Release the claim so Stripe's retry can re-claim and re-run. Without this
    // the event would sit permanently as 'processing' and never be applied —
    // a silently dropped payment. (Stale 'processing' rows are also reclaimable
    // after the staleness window; this is the fast path.)
    await admin
      .from("billing_events")
      .update({ status: "failed" })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  // Completed — mark the claim done and record the payload for audit. Later
  // deliveries of this event now resolve as 'duplicate'.
  let payload: unknown = null;
  try {
    payload = JSON.parse(JSON.stringify(event.data.object));
  } catch {
    payload = null;
  }
  await admin
    .from("billing_events")
    .update({ status: "done", payload })
    .eq("stripe_event_id", event.id);

  return NextResponse.json({ received: true });
}