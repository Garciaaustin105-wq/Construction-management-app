import { NextResponse } from "next/server";
import { getStripe, syncSubscriptionFromEvent } from "@/lib/billing";
import { createAdminClient } from "@/lib/supabase/admin";

// Stripe webhook — SaaS subscriptions only. The platform never touches customer
// money (payments pivot): invoice payments happen on the org's own accounting
// provider (QBO/Xero/FreshBooks) or offline. Must read the raw body
// (request.text()) to verify the signature. Idempotent via the
// billing_events.stripe_event_id unique key.

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

  // Idempotency: CLAIM the event before doing any work. This used to be a
  // SELECT-check, process, then INSERT — which only deduped the log row, not
  // the work: Stripe retries, two concurrent deliveries both passed the SELECT
  // (neither had inserted yet), both processed, and the losing INSERT was
  // silently swallowed. claim_billing_event() makes the unique index a real
  // mutex. See the billing_events_claim migration.
  const admin = createAdminClient();
  const { data: claim, error: claimError } = await admin.rpc(
    "claim_billing_event",
    { p_event_id: event.id, p_event_type: event.type }
  );

  if (claimError) {
    // Couldn't reach the claim table — do NOT process (we can't guarantee
    // exactly-once). 500 so Stripe retries.
    console.error("billing claim failed:", claimError);
    return NextResponse.json({ error: "Claim failed" }, { status: 500 });
  }
  if (claim === "duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }
  if (claim === "in_progress") {
    // Another worker holds a fresh claim. Returning 200 stops Stripe retrying
    // an event that is actively being handled.
    return NextResponse.json({ received: true, inProgress: true });
  }

  // claim === "claimed" — this invocation owns the event.
  let payload: unknown = null;
  try {
    payload = JSON.parse(JSON.stringify(event.data.object));
  } catch {
    payload = null;
  }

  try {
    await syncSubscriptionFromEvent(event);
  } catch (err) {
    console.error("billing sync failed:", err);
    // Release the claim so Stripe's retry can re-claim and re-run. Without
    // this the event would be permanently stuck as 'processing' and never
    // applied. (A stale 'processing' row is also reclaimable after the
    // staleness window, so this is belt-and-braces.)
    await admin
      .from("billing_events")
      .update({ status: "failed" })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  // Completed — mark done and record the payload for audit.
  await admin
    .from("billing_events")
    .update({ status: "done", payload })
    .eq("stripe_event_id", event.id);

  return NextResponse.json({ received: true });
}