import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgForStripeAccount, refreshConnectAccount } from "@/lib/ispBilling";
import {
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  syncFromStripeSubscription,
} from "@/lib/ispSubscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stripe webhook for ISP SUBSCRIBER billing — events from orgs' CONNECTED
// accounts.
//
// ===========================================================================
// WHY THIS IS A SEPARATE ENDPOINT FROM /api/stripe/webhook
// ===========================================================================
// They are different Stripe webhook endpoints with different signing secrets
// and different event scopes:
//
//   /api/stripe/webhook      — PLATFORM account events. The org's SaaS
//                              subscription to this app. STRIPE_WEBHOOK_SECRET.
//   /api/isp/stripe/webhook  — CONNECTED account events (this file). The org's
//                              own subscribers paying the org.
//                              STRIPE_ISP_WEBHOOK_SECRET.
//
// In the Stripe dashboard this endpoint must be created with "Listen to events
// on connected accounts" checked. That is what makes `event.account` arrive
// populated — and `event.account` is the ONLY thing that tells us which org an
// event belongs to. An event without it is a platform event that landed on the
// wrong endpoint, and is ignored rather than guessed at.
//
// Note this is also the payoff of choosing Connect over per-org API keys: with
// stored keys we'd have to trial-decrypt every org's webhook secret to work out
// who a delivery belongs to. Here Stripe just tells us.
//
// ===========================================================================
// IDEMPOTENCY — read before changing the claim logic
// ===========================================================================
// These handlers suspend service, send email, and create invoice rows. Applying
// one twice is user-visible; skipping one that never actually ran is worse.
// So the event log is a CLAIM, not just an audit trail:
//
//   1. Insert the event row (handled = false). A unique violation on
//      stripe_event_id means we've seen this delivery before.
//   2. If we've seen it AND handled = true → genuinely done, ack with 200.
//   3. If we've seen it AND handled = false → a previous attempt died partway.
//      Process it again; every handler is written to be re-appliable.
//   4. On success set handled = true. On failure record the error and return
//      500 so Stripe retries — the row stays handled = false, so step 3 lets
//      the retry through instead of the log swallowing it.
//
// The naive version (insert first, return early on any duplicate) looks correct
// and quietly drops every event whose first attempt failed.

const HANDLED_TYPES = new Set([
  "account.updated",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export async function POST(request: Request) {
  const secret = process.env.STRIPE_ISP_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "ISP webhook secret not configured" },
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

  // `event.account` is present only for connected-account events. Its absence
  // means this endpoint is misconfigured (not listening to connected accounts)
  // or a platform event was routed here. Ack so Stripe stops retrying, but do
  // not attempt to guess an org.
  const stripeAccountId = event.account ?? null;
  if (!stripeAccountId) {
    return NextResponse.json({ received: true, ignored: "no connected account" });
  }

  const admin = createAdminClient();
  const orgId = await getOrgForStripeAccount(stripeAccountId);

  // Not a type we act on: log it and move on, so the org's billing history
  // still shows what Stripe sent.
  if (!HANDLED_TYPES.has(event.type)) {
    await admin
      .from("isp_billing_events")
      .insert({
        organization_id: orgId,
        stripe_account_id: stripeAccountId,
        stripe_event_id: event.id,
        event_type: event.type,
        handled: true,
      })
      .select("id")
      .maybeSingle();
    return NextResponse.json({ received: true, ignored: event.type });
  }

  // ── Step 1-3: claim the event ────────────────────────────────────────────
  let payload: unknown = null;
  try {
    payload = JSON.parse(JSON.stringify(event.data.object));
  } catch {
    payload = null;
  }

  const { error: claimError } = await admin.from("isp_billing_events").insert({
    organization_id: orgId,
    stripe_account_id: stripeAccountId,
    stripe_event_id: event.id,
    event_type: event.type,
    handled: false,
    payload,
  });

  if (claimError) {
    // 23505 = unique_violation on stripe_event_id: we've seen this delivery.
    if (claimError.code !== "23505") {
      return NextResponse.json({ error: "Could not log event" }, { status: 500 });
    }
    const { data: prior } = await admin
      .from("isp_billing_events")
      .select("handled")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (prior?.handled) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // handled = false → a previous attempt failed partway. Fall through and
    // re-process rather than silently dropping it.
  }

  if (!orgId) {
    // A connected account we don't (or no longer) recognize. Logged above;
    // nothing to apply. Ack so Stripe stops retrying.
    await admin
      .from("isp_billing_events")
      .update({ handled: true, error: "unknown connected account" })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, ignored: "unknown account" });
  }

  // ── Step 4: apply ────────────────────────────────────────────────────────
  try {
    switch (event.type) {
      case "account.updated":
        await refreshConnectAccount(orgId);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncFromStripeSubscription(
          orgId,
          event.data.object as Stripe.Subscription
        );
        break;

      case "invoice.paid":
        await handleInvoicePaid(orgId, event.data.object as Stripe.Invoice);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(
          orgId,
          event.data.object as Stripe.Invoice
        );
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "handler failed";
    console.error(`ISP webhook ${event.type} failed:`, err);
    await admin
      .from("isp_billing_events")
      .update({ error: message })
      .eq("stripe_event_id", event.id);
    // 500 → Stripe retries. handled stays false so the retry re-processes.
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  await admin
    .from("isp_billing_events")
    .update({ handled: true, error: null })
    .eq("stripe_event_id", event.id);

  return NextResponse.json({ received: true });
}
