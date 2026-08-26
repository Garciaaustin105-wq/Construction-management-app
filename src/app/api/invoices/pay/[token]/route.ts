import { NextResponse } from "next/server";
import { createInvoiceCheckoutSession } from "@/lib/invoicePay";
import {
  checkRateLimits,
  clientIp,
  rateLimitResponse,
} from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Start a Stripe Checkout session so a customer can pay the invoice balance
// online. PUBLIC — the share_token in the path is the only credential (the
// same token the public /invoices/view/[token] page uses), so there is no auth
// check here. The amount is always computed server-side from the invoice's line
// items; a client can never dictate what to charge. The org must have a
// connected, charges-enabled Stripe account or this returns a clear error. The
// charge is a DIRECT charge on the org's connected account (org is merchant of
// record); paying also saves the card for future auto-pay.

function requestOrigin(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  const host =
    xfhost ||
    request.headers.get("host") ||
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return "localhost";
      }
    })();
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Rate limit: this route is PUBLIC and hits Stripe, so an unthrottled caller
  // holding one valid share token could use it for card testing. Because these
  // are DIRECT charges (the org is merchant of record), that abuse would land
  // on the ORG's Stripe account and their decline rate — not the platform's.
  // Keyed on BOTH the token and the IP so rotating IPs can't hammer one
  // invoice, and one IP can't spray many invoices. A real customer pays once,
  // occasionally retrying a declined card, so these caps are generous.
  const limited = await checkRateLimits([
    { key: `invoice-pay:token:${token}`, max: 8, windowSeconds: 3600 },
    { key: `invoice-pay:ip:${clientIp(request)}`, max: 30, windowSeconds: 3600 },
  ]);
  if (!limited.allowed) return rateLimitResponse(limited);

  try {
    const { url } = await createInvoiceCheckoutSession({
      token,
      origin: requestOrigin(request),
    });
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start payment";
    // 400 for the expected, customer-facing reasons (already paid, no balance,
    // payments not set up); 500 for anything unexpected.
    const expected =
      /already paid|voided|no balance due|hasn't set up|hasn't finished|not found/i.test(
        message
      );
    return NextResponse.json({ error: message }, { status: expected ? 400 : 500 });
  }
}