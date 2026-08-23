"use client";

import { useState } from "react";

// Public review-rating gate (client). Renders on /r/{token} (the server page
// resolves the review_requests row + org name + Google review URL + customer
// name, then passes the token + display data here). The customer picks 1-5
// stars; happy (4-5★) → we record the rating and offer a Google Business
// Profile review, unhappy (1-3★) → we capture internal feedback the office
// sees so a bad experience never becomes a public 1★. POSTs to
// /api/review-feedback (service-role, token-validated). Honeypot field
// `company_website` is hidden from real users — bots fill it and get a silent
// success with nothing POSTed (mirrors LeadCaptureForm / /api/signup).

const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm";

export default function ReviewGate({
  token,
  customerName,
  googleReviewUrl,
  alreadyAnswered,
}: {
  token: string;
  orgName: string;
  customerName: string | null;
  googleReviewUrl: string | null;
  alreadyAnswered: boolean;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string>("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (alreadyAnswered) {
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
        <p className="text-lg font-semibold text-gray-900">
          Thanks - we already have your feedback.
        </p>
      </div>
    );
  }

  const isHappy = rating != null && rating >= 4;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    // Honeypot first — a bot fills the hidden field; silently "succeed" and stop.
    const hp = String(form.get("company_website") ?? "").trim();
    if (hp) {
      setSubmitted(true);
      return;
    }
    if (rating == null) {
      setError("Please pick a rating first.");
      return;
    }
    setBusy(true);
    const payload: Record<string, unknown> = {
      token,
      rating,
      company_website: "", // sent empty (belt-and-suspenders; server re-checks)
    };
    const note = feedback.trim();
    if (note) payload.feedback = note;
    try {
      const res = await fetch("/api/review-feedback", {
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
        {isHappy ? (
          <>
            <p className="text-lg font-semibold text-gray-900">
              Thanks for the great review!
            </p>
            {googleReviewUrl ? (
              <a
                href={googleReviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block bg-green-700 text-white font-semibold text-sm rounded-lg px-5 py-3 mt-4 active:bg-green-800"
              >
                Leave a Google review
              </a>
            ) : (
              <p className="text-sm text-gray-600 mt-2">
                We&apos;re glad you were happy!
              </p>
            )}
          </>
        ) : (
          <p className="text-lg font-semibold text-gray-900">
            Thank you - the office will follow up.
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Honeypot - visually hidden, never filled by humans. */}
      <input
        type="text"
        name="company_website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute opacity-0 pointer-events-none -z-10"
        style={{ width: 0, height: 0 }}
      />

      <h2 className="text-xl font-semibold text-gray-900">
        How was your service{customerName ? `, ${customerName}` : ""}?
      </h2>

      <div className="flex justify-center gap-2" role="group" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => setRating(star)}
            aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
            className={`text-4xl leading-none transition-colors ${
              rating != null && star <= rating
                ? "text-amber-400"
                : "text-gray-300 hover:text-amber-300"
            }`}
          >
            ★
          </button>
        ))}
      </div>

      {rating != null && isHappy && (
        <p className="text-sm text-gray-600 text-center">
          Glad to hear it! Would you mind leaving us a Google review?
        </p>
      )}

      {rating != null && !isHappy && (
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-gray-700">
            We&apos;re sorry we fell short. Tell us what went wrong so we can fix
            it.
          </label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={2000}
            rows={3}
            className={inputCls}
            placeholder="What went wrong?"
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {rating != null && (
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-green-700 text-white font-semibold text-sm rounded-lg px-4 py-3 disabled:opacity-60 active:bg-green-800"
        >
          {busy
            ? "Sending..."
            : isHappy
            ? "Submit rating"
            : "Submit feedback"}
        </button>
      )}
    </form>
  );
}