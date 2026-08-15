import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// PKCE email-link callback — shared by the password-reset and signup-verification
// flows. Supabase email links point here (via its /auth/v1/verify endpoint) with
// ?code=...&type=recovery|signup. We exchange the code server-side for a session
// (this sets the auth cookies via @supabase/ssr's cookie wiring) and then branch
// on the link type:
//   • recovery → /update-password  (user sets a new password)
//   • signup   → /login?verified=1 (email now confirmed; they sign in)
//
// Exchanging the code here (rather than relying on the browser client's
// detectSessionInUrl) is the officially recommended @supabase/ssr PKCE pattern:
// it's race-free and independent of that flag's default.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");

  if (!code) {
    return NextResponse.redirect(new URL("/login", url));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // Code already consumed / expired / invalid. Send them to login with a flag
    // the login page can surface.
    return NextResponse.redirect(new URL("/login?error=reset_failed", url));
  }

  // Branch on our own `flow` param (forgot-password sends flow=recovery,
  // signup sends flow=signup). Supabase's PKCE redirect reliably appends only
  // `code` to the redirect_to — `type` is NOT guaranteed to be forwarded, so
  // relying on it alone would misroute recovery clicks to the "verified" login
  // screen instead of /update-password. We keep `type` as a fallback for any
  // Supabase version that does forward it.
  const flow = url.searchParams.get("flow");
  const isRecovery = flow === "recovery" || type === "recovery";
  if (isRecovery) {
    return NextResponse.redirect(new URL("/update-password", url));
  }
  // signup verification (and any other flow) → email is confirmed, prompt sign-in.
  return NextResponse.redirect(new URL("/login?verified=1", url));
}