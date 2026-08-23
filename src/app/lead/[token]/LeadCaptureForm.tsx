"use client";

import { useState } from "react";
import { LEAD_SOURCES } from "@/lib/leads";

// Public lead-capture form (client). Renders on /lead/{token} (the server page
// resolves the org + passes the token). POSTs to /api/leads (service-role,
// token-validated). On success shows a thank-you state; on error shows the
// message. Honeypot field `company_website` is hidden from real users — bots
// fill it and get a silent 201 with nothing inserted (mirrors /api/signup).

const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm";
const labelCls = "block text-xs font-semibold text-gray-700 mb-1";

export default function LeadCaptureForm({
  token,
  orgName,
}: {
  token: string;
  orgName: string;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const payload = {
      token,
      name: String(form.get("name") ?? "").trim(),
      contact_name: String(form.get("contact_name") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      phone: String(form.get("phone") ?? "").trim(),
      address: String(form.get("address") ?? "").trim(),
      service_interest: String(form.get("service_interest") ?? "").trim(),
      source: String(form.get("source") ?? "website"),
      referral_detail: String(form.get("referral_detail") ?? "").trim(),
      company_website: String(form.get("company_website") ?? "").trim(), // honeypot
    };
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        setSubmitted(true);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <div className="text-center py-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-green-100 flex items-center justify-center mb-3">
          <svg
            className="w-6 h-6 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-lg font-semibold text-gray-900">Thanks!</p>
        <p className="text-sm text-gray-600 mt-1">
          {orgName} will reach out to you shortly.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Honeypot — visually hidden, never filled by humans. */}
      <input
        type="text"
        name="company_website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute opacity-0 pointer-events-none -z-10"
        style={{ width: 0, height: 0 }}
      />

      <div>
        <label className={labelCls} htmlFor="name">
          Name *
        </label>
        <input
          id="name"
          name="name"
          required
          maxLength={120}
          className={inputCls}
          placeholder="Your name"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            maxLength={160}
            className={inputCls}
            placeholder="you@email.com"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="phone">
            Phone
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            maxLength={40}
            className={inputCls}
            placeholder="(555) 123-4567"
          />
        </div>
      </div>

      <p className="text-[11px] text-gray-500 -mt-2">
        Email or phone — whichever you prefer.
      </p>

      <div>
        <label className={labelCls} htmlFor="address">
          Property address
        </label>
        <input
          id="address"
          name="address"
          maxLength={240}
          className={inputCls}
          placeholder="123 Main St, City, ST"
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="service_interest">
          What do you need?
        </label>
        <textarea
          id="service_interest"
          name="service_interest"
          maxLength={500}
          rows={3}
          className={inputCls}
          placeholder="Lawn mowing, weed control, seasonal cleanup…"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="source">
            How did you hear about us?
          </label>
          <select id="source" name="source" className={inputCls} defaultValue="website">
            {LEAD_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="referral_detail">
            Referral details
          </label>
          <input
            id="referral_detail"
            name="referral_detail"
            maxLength={160}
            className={inputCls}
            placeholder="Who referred you?"
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full bg-green-700 text-white font-semibold text-sm rounded-lg px-4 py-3 disabled:opacity-60 active:bg-green-800"
      >
        {busy ? "Sending…" : "Request quote"}
      </button>
    </form>
  );
}