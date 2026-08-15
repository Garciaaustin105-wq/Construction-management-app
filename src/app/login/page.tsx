"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

function Banner() {
  // Reads query flags set by /auth/callback and /reset-password and surfaces
  // them inline. Wrapped in <Suspense> because useSearchParams forces the page
  // into a client boundary.
  const sp = useSearchParams();
  const verified = sp.get("verified") === "1";
  const reset = sp.get("reset") === "1";
  const failed = sp.get("error") === "reset_failed";
  if (!verified && !reset && !failed) return null;
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
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (!data.session) {
      toast.error("Logged in but no session. Try again.");
      setLoading(false);
      return;
    }
    toast.success("Signed in");
    // Use a small delay so the auth cookie is fully set before navigating.
    // router.replace (not window.location) so it's a proper Next navigation.
    setTimeout(() => {
      router.replace("/dashboard");
    }, 200);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <form
        onSubmit={handleLogin}
        className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4"
      >
        <div className="text-center mb-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/terra-vista-logo.svg"
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
            required
            className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            autoComplete="current-password"
          />
        </div>
        <div className="text-right -mt-2">
          <Link
            href="/forgot-password"
            className="text-xs text-blue-600 active:text-blue-700"
          >
            Forgot password?
          </Link>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? "Signing in..." : "Sign In"}
        </button>

        <Link
          href="/signup"
          className="block text-center text-sm text-blue-600 active:text-blue-700"
        >
          Sign up your business
        </Link>
      </form>
    </main>
  );
}