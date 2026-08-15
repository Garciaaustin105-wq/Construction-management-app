import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// PKCE email-link callback — now used only by the signup-verification flow.
// Supabase signup verification links point here (via its /auth/v1/verify
// endpoint) with ?code=...&type=signup. We exchange the code server-side for a
// session (this sets the auth cookies via @supabase/ssr's cookie wiring) and
// redirect to /login?verified=1 (email now confirmed; they sign in).
//
// NOTE: password reset no longer goes through here. The old PKCE recovery
// flow needed a code_verifier COOKIE on the requesting device, so clicking
// the link cross-device (or in the installed PWA) failed. Reset now uses a
// custom single-use token at /reset-password → /api/reset-password — see
// password_resets.sql and src/app/api/forgot-password.
//
// Exchanging the code here (rather than relying on the browser client's
// detectSessionInUrl) is the officially recommended @supabase/ssr PKCE pattern:
// it's race-free and independent of that flag's default.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

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

  // Signup verification: email is now confirmed, prompt sign-in.
  return NextResponse.redirect(new URL("/login?verified=1", url));
}