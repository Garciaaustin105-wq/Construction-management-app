import type Stripe from "stripe";
import { NextResponse } from "next/server";
import { getStripe, syncSubscriptionFromEvent } from "@/lib/billing";
import { applyInvoicePayment } from "@/lib/invoicePay";
import { createAdminClient } from "@/lib/supabase/admin";

// Stripe webhook — syncs the org's plan/status from subscription events AND
// records customer invoice payments (Stripe Connect destination charges).
// Must read the raw body (request.text()) to verify the signature. Idempotent
// via the billing_events.stripe_event_id unique key.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = await getStripe();
  let event;
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

  // Route the event. A one-time invoice payment (Stripe Connect destination
  // charge) is a checkout.session.completed with mode === "payment" — handled
  // by applyInvoicePayment (records amount_paid/status on the invoice). Every
  // other event (subscription lifecycle) goes through the SaaS sync. If it
  // throws, return 500 WITHOUT recording the event so Stripe retries (both
  // paths are idempotent — re-applying is safe).
  try {
    if (
      event.type === "checkout.session.completed" &&
      (event.data.object as Stripe.Checkout.Session).mode === "payment"
    ) {
      await applyInvoicePayment(event.data.object as Stripe.Checkout.Session);
    } else {
      await syncSubscriptionFromEvent(event);
    }
  } catch (err) {
    console.error("billing sync failed:", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  // Record the event for audit. Ignore a unique-violation race (two concurrent
  // deliveries of the same event) — the sync already happened.
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