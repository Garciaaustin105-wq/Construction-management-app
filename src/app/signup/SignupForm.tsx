"use client";

import { useState } from "react";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";

// Client form for the public self-serve signup. The org + admin creation
// happens server-side in /api/signup (service role, env-gated by SAAS_OPEN).
// Includes a hidden honeypot field ("company_website") that bots fill but real
// users never see — the API silently drops honeypot-hit submissions.
//
// Both success and error states render as PERSISTENT inline panels (not brief
// toasts) so the result is unambiguous: a successful signup shows a clear
// "workspace created" screen the user clicks through to sign in, and any
// error stays visible until the next submit.
export default function SignupForm() {
  const [businessName, setBusinessName] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Honeypot — must stay empty. Visually hidden, tab-indexed out of the flow.
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [loading, setLoading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setInlineError(null);

    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business_name: businessName,
        full_name: fullName,
        email,
        password,
        company_website: companyWebsite,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      // Every error shows inline (persistent) so the user can actually read it
      // — 503 (closed), 429 (rate limited), 400 (validation), 409 (dup email),
      // and 500 (server) all surface the exact API message.
      setInlineError(data.error ?? "Sign up failed. Please try again.");
      setLoading(false);
      return;
    }

    setSuccessEmail(email.trim());
    setEmailSent(data.emailSent !== false);
    setLoading(false);
  }

  // ── Success state ───────────────────────────────────────────────────────
  if (successEmail) {
    return (
      <div className="w-full max-w-sm bg-white p-6 rounded-lg shadow-sm space-y-4 text-center">
        <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
        <h1 className="text-lg font-semibold text-gray-900">
          Workspace created
        </h1>
        <p className="text-sm text-gray-600">
          We sent a verification link to your email. Click it to confirm your
          address, then sign in to continue.
        </p>
        <p className="text-xs text-gray-400 break-all">{successEmail}</p>
        {emailSent ? null : (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            We couldn&apos;t send your verification email right now. Your
            workspace is created — contact support to resend the verification
            link.
          </p>
        )}
        <Link
          href="/login"
          className="block w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700"
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
          src="/terra-vista-logo.svg"
          alt="Terra Vista Construction Management"
          width={260}
          height={72}
          className="mx-auto mb-1"
        />
        <p className="text-xs text-gray-500 mt-1">
          Create your business workspace
        </p>
      </div>

      {inlineError && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          {inlineError}
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Business name
        </span>
        <input
          type="text"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          required
          placeholder="Acme Electrical"
          className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Your name</span>
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          placeholder="Jane Doe"
          className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          placeholder="you@business.com"
          className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Password</span>
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

      {/* Honeypot: hidden from real users (CSS + aria-hidden + negative tab
          order). Bots that autofill every field will set this and be rejected
          silently by the API. */}
      <input
        type="text"
        name="company_website"
        value={companyWebsite}
        onChange={(e) => setCompanyWebsite(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {loading ? "Creating your workspace..." : "Create workspace"}
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