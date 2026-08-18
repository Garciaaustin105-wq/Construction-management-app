"use client";

import { useState, Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Mail } from "lucide-react";
import { useToast } from "@/components/Toast";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { isLawn, APP_VARIANT, APP_URLS, type AppVariant } from "@/lib/variant";

function Banner() {
  // Reads query flags set by /auth/callback and /reset-password and surfaces
  // them inline. Wrapped in <Suspense> because useSearchParams forces the page
  // into a client boundary.
  const sp = useSearchParams();
  const verified = sp.get("verified") === "1";
  const reset = sp.get("reset") === "1";
  const failed = sp.get("error") === "reset_failed";
  const wrongAppParam = sp.get("wrong_app");
  const wrongApp: AppVariant | null =
    wrongAppParam === "lawn" || wrongAppParam === "construction" ? wrongAppParam : null;
  if (!verified && !reset && !failed && !wrongApp) return null;
  if (wrongApp) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <p className="font-semibold">
          This account belongs to the{" "}
          {wrongApp === "lawn" ? "Terra Verde (lawn)" : "Terra Vista (construction)"} app.
        </p>
        <p className="mt-1">Sign in on the correct app:</p>
        <a
          href={`${APP_URLS[wrongApp]}/login`}
          className="mt-2 inline-block font-semibold text-brand active:text-brand-dark underline"
        >
          Go to {wrongApp === "lawn" ? "Terra Verde" : "Terra Vista"} →
        </a>
      </div>
    );
  }
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        verified || reset
          ? "bg-emerald-50 border-emerald-200 text-emerald-800"
          : "bg-amber-50 border-amber-200 text-amber-800"
      }`}
    >
      {verified
        ? "Your email is verified — sign in to continue."
        : reset
          ? "Your password has been updated — sign in."
          : "That reset link is invalid or has expired. Try sending a new one."}
    </div>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // "magic-link" mode: the office can email a passwordless sign-in link to the
  // typed address (used by invited customers — and any user who'd rather not
  // type a password). Supabase sends its own magic-link email; clicking it
  // exchanges at /auth/callback?flow=client and routes by role.
  const [linkSent, setLinkSent] = useState(false);
  // When a user signs into the wrong app (auth is shared across both deploys),
  // we sign them back out and set this so the form shows a banner pointing them
  // to their home app. null = no mismatch.
  const [wrongApp, setWrongApp] = useState<AppVariant | null>(null);
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();

  // Implicit-flow magic-link recovery. Admin-generated magic links
  // (generateLink({type:'magiclink'}) — used by the Client Portal invite +
  // "Send as Proposal") can't do PKCE (no client-side code_verifier), so
  // Supabase falls back to the IMPLICIT flow: it redirects here to /login with
  // the session tokens in the URL *fragment* (#access_token=…&refresh_token=…).
  // Fragments aren't sent to the server, so /auth/callback (which only handles
  // the PKCE ?code= case) never sees them — the user would be stranded on
  // /login with a valid session sitting unused in the address bar. With
  // flowType 'pkce' (the default), the browser client also won't auto-detect
  // the fragment (detectSessionInUrl is false). So we consume it explicitly:
  // setSession → route by role + variant affinity (mirrors /auth/callback).
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.includes("access_token=")) return;
    const params = new URLSearchParams(
      hash.startsWith("#") ? hash.slice(1) : hash
    );
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (!accessToken || !refreshToken) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      // Clear the fragment so the tokens don't linger in the address bar /
      // browser history regardless of outcome.
      window.history.replaceState(null, "", "/login");
      if (cancelled) return;
      if (error || !data.user) {
        toast.error("That sign-in link is invalid or has expired.");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, organization_id")
        .eq("id", data.user.id)
        .maybeSingle();
      // Super_admin (no org) → variant home.
      if (!profile || profile.role === "super_admin" || !profile.organization_id) {
        router.replace(isLawn() ? "/lawn" : "/dashboard");
        return;
      }
      const { data: org } = await supabase
        .from("organizations")
        .select("app_variant")
        .eq("id", profile.organization_id)
        .maybeSingle();
      const homeVariant: AppVariant =
        org?.app_variant === "lawn" ? "lawn" : "construction";
      if (homeVariant !== APP_VARIANT) {
        // Wrong-app bounce: sign out + show the cross-app banner.
        await supabase.auth.signOut();
        setWrongApp(homeVariant);
        return;
      }
      const dest =
        profile.role === "customer"
          ? "/customer"
          : isLawn()
            ? "/lawn"
            : "/dashboard";
      router.replace(dest);
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount — the fragment is only present on the initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a successful sign-in, confirm the account's org belongs to THIS
  // variant. Both apps share one Supabase auth backend, so without this check a
  // construction-org user could sign into the lawn app (or vice versa) and see
  // the wrong brand over their own data. Cookies are per-domain, so the only
  // way into the wrong app is re-entering credentials here — gate it at the
  // sign-in event. Super_admin (platform, no org) may use either app. Returns
  // the user's home variant on mismatch, or null if the account belongs here
  // (or its variant can't be determined — fail open, the app's RLS still scopes
  // data to the user's own org either way).
  async function homeVariantIfMismatched(userId: string): Promise<AppVariant | null> {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, organization_id")
      .eq("id", userId)
      .maybeSingle();
    if (!profile || profile.role === "super_admin") return null;
    const orgId = (profile.organization_id as string | null) ?? null;
    if (!orgId) return null;
    const { data: org } = await supabase
      .from("organizations")
      .select("app_variant")
      .eq("id", orgId)
      .maybeSingle();
    if (!org) return null;
    const home: AppVariant = org.app_variant === "lawn" ? "lawn" : "construction";
    return home === APP_VARIANT ? null : home;
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setWrongApp(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (!data.session || !data.user) {
      toast.error("Logged in but no session. Try again.");
      setLoading(false);
      return;
    }
    // Affinity check: refuse + bounce if this account belongs to the other app.
    const wrongHome = await homeVariantIfMismatched(data.user.id);
    if (wrongHome) {
      await supabase.auth.signOut();
      setWrongApp(wrongHome);
      setLoading(false);
      return;
    }
    toast.success("Signed in");
    // Use a small delay so the auth cookie is fully set before navigating.
    // router.replace (not window.location) so it's a proper Next navigation.
    setTimeout(() => {
      router.replace(isLawn() ? "/lawn" : "/dashboard");
    }, 200);
  }

  // Passwordless sign-in: Supabase emails a magic link to the typed address.
  // Used by invited customers (the office sends their link via /api/clients/
  // invite, but a customer who lost it can request a fresh one here) and by any
  // user who'd rather not type a password. The link exchanges at
  // /auth/callback?flow=client, which routes by role (customer → /customer).
  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setWrongApp(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // Relative redirect resolves to this deploy's origin; the callback
        // routes the signed-in user by their role + org variant.
        emailRedirectTo: `${window.location.origin}/auth/callback?flow=client`,
      },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setLinkSent(true);
    toast.success("Check your email for a sign-in link.");
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form
        onSubmit={linkSent ? undefined : handleMagicLink}
        className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4"
      >
        <div className="text-center mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={BRAND.logoPath}
            alt={BRAND.company}
            width={260}
            height={72}
            className="mx-auto mb-1"
          />
          <p className="text-xs text-gray-500 mt-1">Sign in to continue</p>
        </div>
        <Suspense>
          <Banner />
        </Suspense>
        {wrongApp && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p className="font-semibold">
              This account belongs to the{" "}
              {wrongApp === "lawn" ? "Terra Verde (lawn)" : "Terra Vista (construction)"} app.
            </p>
            <p className="mt-1">
              You&apos;ve been signed out here. Sign in on the correct app:
            </p>
            <a
              href={`${APP_URLS[wrongApp]}/login`}
              className="mt-2 inline-block font-semibold text-brand active:text-brand-dark underline"
            >
              Go to {wrongApp === "lawn" ? "Terra Verde" : "Terra Vista"} →
            </a>
          </div>
        )}
        {linkSent ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800 space-y-2">
            <p className="font-semibold flex items-center gap-2">
              <Mail className="w-4 h-4" /> Check your email
            </p>
            <p>
              We sent a sign-in link to <strong>{email}</strong>. Click it to
              sign in — the link expires shortly.
            </p>
            <button
              type="button"
              onClick={() => setLinkSent(false)}
              className="text-emerald-800 underline font-medium"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="email" className="sr-only">
                Email
              </label>
              <input
                id="email"
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                Password
              </label>
              <input
                id="password"
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
                autoComplete="current-password"
              />
            </div>
            <div className="text-right -mt-2">
              <Link
                href="/forgot-password"
                className="text-xs text-brand active:text-brand-dark"
              >
                Forgot password?
              </Link>
            </div>
            <button
              type="button"
              onClick={handleLogin}
              disabled={loading}
              className="w-full bg-brand text-white py-3 rounded-lg font-semibold active:bg-brand-dark disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? "Signing in..." : "Sign In"}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              Email me a sign-in link
            </button>

            <Link
              href="/signup"
              className="block text-center text-sm text-brand active:text-brand-dark"
            >
              Sign up your business
            </Link>
          </>
        )}
      </form>
    </main>
  );
}