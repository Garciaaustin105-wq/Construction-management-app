import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the session ONLY when the access token is at/near expiry. A full
  // `getUser()` is a network round-trip to /auth/v1/user on EVERY matched
  // request (incl. <Link> prefetches) — the largest TTFB cost in the auth
  // preamble. `getSession()` reads the cookie LOCALLY (no network, chunking
  // handled) and exposes `expires_at`, so we skip the network call in the
  // common (token still valid) case and only pay it when a refresh is due.
  //
  // SAFE because this proxy does NOT enforce auth — it only refreshes the
  // cookie; the cookie is validated per-request by the DATA layer instead of
  // by a proxy getUser: getMe() (src/lib/tenant.ts, warmed by the root layout
  // on every server render) calls the get_my_tenant() RPC, and PostgREST 401s
  // on an invalid/expired JWT BEFORE invoking the function — that 401 is the
  // session-validation step getUser() used to provide. Public pages that
  // don't call getMe don't need validation. A revoked/deleted user retains
  // access only until their still-valid JWT expires (standard Supabase JWT
  // tradeoff, bounded by the token lifetime).
  // See src/proxy.ts header ("this proxy does NOT gate on the session").
  const REFRESH_WITHIN_S = 300; // network-validate+refresh if <5 min of life left
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (
    session?.expires_at &&
    session.expires_at - Math.floor(Date.now() / 1000) < REFRESH_WITHIN_S
  ) {
    await supabase.auth.getUser();
  }

  return supabaseResponse;
}
