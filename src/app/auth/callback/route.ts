import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isLawn, APP_VARIANT } from "@/lib/variant";
import { needsMfaChallenge } from "@/lib/mfaGate";

// PKCE email-link callback. Two flows share this route (both arrive with
// ?code=... from Supabase's /auth/v1/verify):
//
//   flow=signup  — self-serve business signup verification. Email is now
//                  confirmed; send to /login?verified=1 to sign in with the
//                  password they chose. (Unchanged.)
//
//   flow=client   — Client Portal magic-link sign-in (and any magic-link
//                  sign-in requested from /login). After exchanging the code we
//                  have a session; route by role: customer → /customer, anyone
//                  else → this deploy's variant home. Apply the SAME variant-
//                  affinity guard as /login: if the account's org app_variant
//                  ≠ this deploy's APP_VARIANT (and the user isn't super_admin),
//                  sign them out and bounce to /login?wrong_app=<home> so the
//                  login page's banner points them to the correct app. This keeps
//                  a construction-org customer from landing on the lawn deploy
//                  (and vice versa) via a magic link.
//
// Password reset does NOT come through here — it uses a custom single-use token
// at /reset-password → /api/reset-password (password_resets.sql). Exchanging the
// code server-side is the official @supabase/ssr PKCE pattern (race-free).

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const flow = url.searchParams.get("flow");

  if (!code) {
    return NextResponse.redirect(new URL("/login", url));
  }

  const supabase = await createClient();

  // Clear any existing session before exchanging the PKCE code. Without this,
  // a browser that is already signed in (e.g. the office testing a client's
  // magic link, or a customer clicking a fresh "Resend" link) can keep its
  // stale session: Supabase's verify endpoint sees the live session, the
  // exchange no-ops, and getUser() below returns the OLD identity — so a
  // customer magic link routes the office to /dashboard instead of /customer.
  // signOut() here guarantees the exchange establishes the NEW session from
  // the code in the URL. (Harmless on a fresh browser — no session to clear.)
  await supabase.auth.signOut();

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // Code already consumed / expired / invalid.
    return NextResponse.redirect(new URL("/login?error=reset_failed", url));
  }

  // Signup verification: email confirmed → prompt password sign-in.
  if (flow === "signup") {
    return NextResponse.redirect(new URL("/login?verified=1", url));
  }

  // Magic-link sign-in: route by role + enforce variant affinity.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", url));
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .maybeSingle();

  // Super_admin (no org) may use either app; route to the variant home.
  if (!profile || profile.role === "super_admin" || !profile.organization_id) {
    return NextResponse.redirect(new URL(isLawn() ? "/lawn" : "/dashboard", url));
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("app_variant")
    .eq("id", profile.organization_id)
    .maybeSingle();
  const homeVariant = (org?.app_variant === "lawn" ? "lawn" : "construction") as
    | "lawn"
    | "construction";

  // Wrong-app bounce: the account belongs to the other variant. Sign out and
  // hand the login page a flag so its banner points them home.
  if (homeVariant !== APP_VARIANT) {
    await supabase.auth.signOut();
    return NextResponse.redirect(
      new URL(`/login?wrong_app=${homeVariant}`, url)
    );
  }

  // Correct variant: route by role.
  const dest = profile.role === "customer" ? "/customer" : isLawn() ? "/lawn" : "/dashboard";
  if (await needsMfaChallenge(supabase)) {
    return NextResponse.redirect(
      new URL(`/mfa/challenge?next=${encodeURIComponent(dest)}`, url)
    );
  }
  return NextResponse.redirect(new URL(dest, url));
}