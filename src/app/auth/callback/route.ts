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
  //
  // The variant check is NOT redundant with the one below, and this route
  // previously skipped it. Observed on 2026-08-31: a lawn signup completed on a
  // desktop, the emailed link opened on a phone, and the callback ran on the
  // CONSTRUCTION deploy. Supabase honours a redirect only if it is on its
  // allow-list and silently substitutes the project Site URL otherwise, so one
  // missing entry sends every verification to the other app.
  //
  // That is not cosmetic here, because of the two lines above: signOut() had
  // already destroyed whatever session the phone held, and
  // exchangeCodeForSession then minted a session for the NEW account on the
  // WRONG deploy. The user landed on the construction app holding a lawn
  // account's session. RLS still scoped them to their own (empty) org, so no
  // data was exposed — but they were signed out of the app they were using and
  // into one they had never signed up for.
  //
  // An allow-list is configuration and configuration goes missing. This makes
  // the wrong landing recoverable in code.
  if (flow === "signup") {
    const {
      data: { user: newUser },
    } = await supabase.auth.getUser();

    if (newUser) {
      const { data: newProfile } = await supabase
        .from("profiles")
        .select("role, organization_id")
        .eq("id", newUser.id)
        .maybeSingle();

      if (
        newProfile &&
        newProfile.role !== "super_admin" &&
        newProfile.organization_id
      ) {
        const { data: newOrg } = await supabase
          .from("organizations")
          .select("app_variant")
          .eq("id", newProfile.organization_id)
          .maybeSingle();
        const signupHome =
          newOrg?.app_variant === "lawn" ? "lawn" : "construction";

        if (signupHome !== APP_VARIANT) {
          // Do not leave them holding a session on the wrong deploy. The email
          // IS confirmed by this point — the exchange above did that — so the
          // account is fine and they simply need to sign in on the right app.
          await supabase.auth.signOut();
          return NextResponse.redirect(
            new URL(`/login?verified=1&wrong_app=${signupHome}`, url)
          );
        }
      }
    }

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