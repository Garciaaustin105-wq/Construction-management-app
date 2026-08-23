"use client";

import { useState } from "react";
import { Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { isLawn } from "@/lib/variant";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  type BusinessType,
} from "@/lib/businessTypes";

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
  // Seeded from the deploy variant: someone signing up through the lawn app is
  // a lawn business until they say otherwise. Never allowed to reach empty —
  // unticking the last box re-seeds, because the API's column has a
  // cardinality>=1 check and an empty submit would 500 at the very last step of
  // signup, which is the worst possible place to fail.
  const [businessTypes, setBusinessTypes] = useState<BusinessType[]>([
    isLawn() ? "lawn" : "construction",
  ]);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Honeypot — must stay empty. Visually hidden, tab-indexed out of the flow.
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [loading, setLoading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);

  function toggleBusinessType(t: BusinessType) {
    setBusinessTypes((prev) => {
      const next = prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t];
      // Refuse to end up with nothing selected — see the state comment above.
      return next.length > 0 ? next : prev;
    });
  }

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
        // Stamp the org's platform variant at signup so the DB guard +
        // tenant.ts know whether this is a lawn org. The form knows the deploy
        // variant at build time (NEXT_PUBLIC_APP_VARIANT inlined).
        variant: isLawn() ? "lawn" : "construction",
        // What the business actually does — independent of `variant` above,
        // and multi-valued (construction + isp is the motivating case).
        business_types: businessTypes,
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

      {/* What kind of work they do. Multi-select because plenty of small
          contractors do more than one — a construction company that also runs
          fiber is the case that forced this to exist. Seeded with the deploy
          variant already ticked so the common single-trade signup is one tap
          of confirmation rather than a decision. */}
      <fieldset className="block">
        <legend className="text-sm font-medium text-gray-700">
          What kind of work do you do?
        </legend>
        <p className="mt-0.5 text-xs text-gray-500">
          Pick everything that applies — you can change this later.
        </p>
        <div className="mt-2 space-y-2">
          {BUSINESS_TYPES.map((t) => (
            <label
              key={t}
              className="flex items-center gap-3 px-3 py-2.5 border border-gray-300 rounded-lg cursor-pointer active:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={businessTypes.includes(t)}
                onChange={() => toggleBusinessType(t)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-800">
                {BUSINESS_TYPE_LABELS[t]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

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
        className="w-full bg-brand text-white py-3 rounded-lg font-semibold active:bg-brand-dark disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {loading ? "Creating your workspace..." : "Create workspace"}
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