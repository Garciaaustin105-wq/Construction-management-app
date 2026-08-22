import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { AppVariant } from "@/lib/variant";

// Variant-affinity sign-out + bounce. Reached via redirect() from the root
// layout (src/app/layout.tsx) when a PERSISTED session belongs to the OTHER
// variant — the defense-in-depth behind the sign-in-time checks in /login and
// /auth/callback, which a session established earlier entirely skips.
//
// Why a dedicated route instead of signing out in the layout: the layout can't
// read the URL, so an in-layout signOut + redirect to /login could loop if the
// signOut ever failed to clear the cookie (the layout would re-fire on /login,
// see the same wrong-variant session, and bounce again). Routing through here
// breaks that: this signs out ONCE and redirects to /login?wrong_app=<home>; the
// /login load that follows has no session, so the layout guard no-ops and the
// login page renders its "this account belongs to the other app" banner.
//
// GET so it works as a redirect target from a server component. The proxy
// matcher runs /api/** through updateSession (harmless) and does not block
// /api/auth/*. super_admin never reaches here (the layout guard exempts it).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const home = url.searchParams.get("home");
  const homeVariant: AppVariant = home === "lawn" ? "lawn" : "construction";
  const supabase = await createClient();
  try {
    await supabase.auth.signOut();
  } catch {
    // Best-effort — @supabase/ssr clears the session cookies as part of
    // signOut regardless of the network call's outcome, so the redirect still
    // lands on /login without a session. Continue.
  }
  return NextResponse.redirect(new URL(`/login?wrong_app=${homeVariant}`, url));
}