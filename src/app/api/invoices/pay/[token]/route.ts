import { NextResponse } from "next/server";
import { createInvoiceCheckoutSession } from "@/lib/invoicePay";

export const dynamic = "force-dynamic";

// Start a Stripe Checkout session so a customer can pay the invoice balance
// online. PUBLIC — the share_token in the path is the only credential (the
// same token the public /invoices/view/[token] page uses), so there is no auth
// check here. The amount is always computed server-side from the invoice's
// line items; a client can never dictate what to charge. The org must have a
// connected, charges-enabled Stripe account or this returns a clear error.

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