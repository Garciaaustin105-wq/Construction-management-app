"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { BRAND } from "@/lib/brand";

// Sets a new password from a cross-device reset token. The token (from the
// /reset-password?token=... URL) authorizes the change — NOT a session — so
// this works whether the user is signed in or not, on any device. The token is
// POSTed in the request body (not a URL) to /api/reset-password, which claims
// it (single-use, race-safe) and sets the password via the service-role admin
// API.
export default function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const router = useRouter();
  const toast = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setInlineError(null);
    if (password.length < 8) {
      setInlineError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setInlineError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      setLoading(false);
      if (!res.ok || !data?.ok) {
        setInlineError(
          data?.error ??
            "Could not reset your password. The link may have expired — request a new one."
        );
        return;
      }
      setDone(true);
      toast.success("Password updated");
      // Brief pause so the toast is visible before navigating away.
      setTimeout(() => router.replace("/login?reset=1"), 1200);
    } catch {
      setLoading(false);
      setInlineError("Network error. Try again.");
    }
  }

  // ── Success state ───────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4 text-center">
        <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
        <h1 className="text-lg font-semibold text-gray-900">Password updated</h1>
        <p className="text-sm text-gray-600">
          Your password has been changed. Sign in with your new password to
          continue.
        </p>
        <Link
          href="/login"
          className="block w-full bg-brand text-white py-3 rounded-lg font-semibold active:bg-brand-dark"
        >
          Continue to sign in
        </Link>
      </div>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────
  return (
    <form
      onSubmit={handleSubmit}
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
        <p className="text-xs text-gray-500 mt-1">Set a new password</p>
      </div>

      {inlineError && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          {inlineError}
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium text-gray-700">New password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="min. 8 characters"
          className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Confirm new password
        </span>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="re-enter your password"
          className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-brand text-white py-3 rounded-lg font-semibold active:bg-brand-dark disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {loading ? "Updating..." : "Update password"}
      </button>

      <Link
        href="/login"
        className="block text-center text-sm text-brand active:text-brand-dark flex items-center justify-center gap-1"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to sign in
      </Link>
    </form>
  );
}