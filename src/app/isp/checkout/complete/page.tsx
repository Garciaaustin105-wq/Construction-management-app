import { CheckCircle2, XCircle, Wifi } from "lucide-react";

export const dynamic = "force-dynamic";

// Public landing page for ISP subscribers returning from Stripe.
//
// WHY THIS EXISTS — it replaces the deleted /portal/subscription.
// Under the office-managed model an ISP subscriber has NO auth.users row, NO
// profiles row, and never logs into this app. But Stripe still requires
// somewhere to send them:
//   * Checkout success_url / cancel_url  (after entering their card)
//   * Billing Portal return_url          (after updating payment details)
// Those are hit by a signed-OUT stranger holding only a link the office sent
// them. So this page MUST NOT call getMe(), read profiles, or touch RLS — any
// auth check here turns a completed payment into a redirect to /login, which
// looks like the payment failed.
//
// It deliberately shows NO account data. We know nothing about who is looking
// at this page — the URL carries no token and proves nothing — so it confirms
// the action and stops. Anything account-specific would be an unauthenticated
// data leak keyed on a guessable URL.
//
// Not linked from any nav. Reachable only by coming back from Stripe.

export default async function IspCheckoutCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const canceled = checkout === "canceled";

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-sm p-6 text-center">
        {canceled ? (
          <>
            <XCircle className="h-10 w-10 text-gray-400 mx-auto" />
            <h1 className="mt-3 text-lg font-semibold text-gray-900">
              Sign-up canceled
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              No payment was taken and nothing has changed. You can reopen the
              link your provider sent you whenever you&apos;re ready.
            </p>
          </>
        ) : (
          <>
            <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
            <h1 className="mt-3 text-lg font-semibold text-gray-900">
              You&apos;re all set
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              Thanks — your payment details are saved and your internet service
              is being set up. Your provider will be in touch about scheduling.
            </p>
            <p className="mt-3 text-xs text-gray-500">
              A receipt is on its way to your email.
            </p>
          </>
        )}

        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-gray-400">
          <Wifi className="h-3.5 w-3.5" />
          You can close this window.
        </p>
      </div>
    </div>
  );
}
