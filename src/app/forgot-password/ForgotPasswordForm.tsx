"use client";

import { useState } from "react";
import { Loader2, ArrowLeft, CheckCircle2, Mail } from "lucide-react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

// Client form for the password-reset request. POSTs the email to our own
// /api/forgot-password, which mints a single-use, 15-minute bearer token and
// emails https://<origin>/reset-password?token=<raw> via Resend.
//
// Why not Supabase's resetPasswordForEmail: that flow is PKCE — the email link
// carries only a `code`, and finishing needs a `code_verifier` COOKIE on the
// device that requested the reset. Click the link on another device / the
// installed PWA and it fails. Our custom token lives ENTIRELY in the link, so
// it works cross-device. See password_resets.sql + /reset-password +
// /api/reset-password.
//
// Terminal success + error states render as PERSISTENT inline panels (not
// toasts) so the result is unambiguous — same UX lesson as SignupForm. The
// server always returns generic { ok: true } (no-existence-leak), so the
// success panel is shown even for unknown emails.
export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setInlineError(null);

    try {
      const res = await fetch("/api/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      setLoading(false);
      if (!res.ok) {
        setInlineError(
          data?.error ??
            "Could not send a reset link right now. Try again or contact support."
        );
        return;
      }
      setSentTo(email.trim());
    } catch {
      setLoading(false);
      setInlineError("Network error. Try again.");
    }
  }

  // ── Success state ───────────────────────────────────────────────────────
  if (sentTo) {
    return (
      <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4 text-center">
        <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
        <h1 className="text-lg font-semibold text-gray-900">Check your email</h1>
        <p className="text-sm text-gray-600">
          We sent a password reset link to your email. Click it to choose a new
          password, then sign in.
        </p>
        <p className="text-xs text-gray-400 break-all">{sentTo}</p>
        <Link
          href="/login"
          className="block text-center text-sm text-blue-600 active:text-blue-700 flex items-center justify-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to sign in
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
          src="/terra-vista-logo.svg"
          alt={BRAND.company}
          width={260}
          height={72}
          className="mx-auto mb-1"
        />
        <p className="text-xs text-gray-500 mt-1">Reset your password</p>
      </div>

      {inlineError && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          {inlineError}
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Email</span>
        <div className="relative mt-1">
          <Mail className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@business.com"
            className="block w-full pl-9 pr-3 py-3 border border-gray-300 rounded-lg text-base"
          />
        </div>
      </label>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {loading ? "Sending reset link..." : "Send reset link"}
      </button>

      <Link
        href="/login"
        className="block text-center text-sm text-blue-600 active:text-blue-700 flex items-center justify-center gap-1"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to sign in
      </Link>
    </form>
  );
}