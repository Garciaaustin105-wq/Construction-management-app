import { NextResponse } from "next/server";
import { createSaveCardCheckoutSession } from "@/lib/invoiceCharge";
import {
  checkRateLimits,
  clientIp,
  rateLimitResponse,
} from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Start a Stripe Checkout session (mode=setup) so a customer can save a card
// for automatic payments WITHOUT being charged now. PUBLIC — the share_token in
// the path is the only credential (same as the Pay path). The saved card lives
// on the org's connected account (direct charges); cycle billing later charges
// it off-session. The org must have a connected, charges-enabled Stripe account
// or this returns a clear error.

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

  // Same abuse surface as the Pay route (public + hits Stripe on the org's
  // connected account), so the same dual token+IP throttle. Saving a card is a
  // once-per-customer action, so the token cap is tighter than Pay's.
  const limited = await checkRateLimits([
    { key: `invoice-savecard:token:${token}`, max: 5, windowSeconds: 3600 },
    {
      key: `invoice-savecard:ip:${clientIp(request)}`,
      max: 20,
      windowSeconds: 3600,
    },
  ]);
  if (!limited.allowed) return rateLimitResponse(limited);

  try {
    const { url } = await createSaveCardCheckoutSession({
      token,
      origin: requestOrigin(request),
    });
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start card setup";
    const expected =
      /No customer|hasn't set up|hasn't finished|not found|not set up/i.test(message);
    return NextResponse.json({ error: message }, { status: expected ? 400 : 500 });
  }
}