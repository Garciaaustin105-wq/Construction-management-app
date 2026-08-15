import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import ResetPasswordForm from "./ResetPasswordForm";

export const dynamic = "force-dynamic";

// Token URLs must never be indexed.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Landing page for the cross-device reset link
// (https://<prod>/reset-password?token=<raw>). The token in the URL is the
// sole proof of intent — NO PKCE code_verifier, NO session required — so this
// page works whether the link opens in a desktop browser, a phone browser, or
// the installed PWA. See password_resets.sql + /api/forgot-password.
//
// PUBLIC: we do NOT require a signed-in user. The token authorizes the change,
// not the session. Middleware (proxy) runs on this route but is pass-through.
//
// Next 16: searchParams is a Promise — must await it (forgetting yields a
// Promise object, not the string).

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Shared invalid/expired panel so both the "no token" and "bad token" states
// look identical (don't distinguish "link had no token" from "token was
// rejected" — both just tell the user to request a new one).
function InvalidLink() {
  return (
    <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4 text-center">
      <h1 className="text-lg font-semibold text-gray-900">
        Reset link invalid
      </h1>
      <p className="text-sm text-gray-600">
        This reset link is invalid, expired, or has already been used. Reset
        links expire after 15 minutes and can only be used once.
      </p>
      <Link
        href="/forgot-password"
        className="block w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700"
      >
        Send a new link
      </Link>
      <Link
        href="/login"
        className="block text-center text-sm text-blue-600 active:text-blue-700"
      >
        Back to sign in
      </Link>
    </div>
  );
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token || typeof token !== "string") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <InvalidLink />
      </main>
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const hash = sha256Hex(token);
  const { data: row } = await admin
    .from("password_resets")
    .select("user_id, expires_at, used_at")
    .eq("token_hash", hash)
    .maybeSingle();

  // Server components render once per request, so reading the wall clock here
  // is correct (the react-hooks/purity rule targets client re-renders, where a
  // non-deterministic value would change between renders).
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const valid =
    row && !row.used_at && new Date(row.expires_at).getTime() > now;

  if (!valid) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <InvalidLink />
      </main>
    );
  }

  // Token is live — render the set-password form. Pass the raw token to the
  // client form, which POSTs it (in the body, not a URL) to /api/reset-password.
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <ResetPasswordForm token={token} />
    </main>
  );
}