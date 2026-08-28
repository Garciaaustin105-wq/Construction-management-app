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
  leadFormToken,
  alreadyAnswered,
}: {
  token: string;
  orgName: string;
  customerName: string | null;
  googleReviewUrl: string | null;
  leadFormToken: string | null;
  alreadyAnswered: boolean;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string>("");
  const [photoB64, setPhotoB64] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<
    { platform: string; review_url: string }[] | null
  >(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const PLATFORM_LABEL: Record<string, string> = {
    google: "Leave a Google review",
    facebook: "Leave a Facebook review",
    yelp: "Leave a Yelp review",
    nextdoor: "Leave a Nextdoor recommendation",
  };

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
    if (photoB64) payload.photo = photoB64;
    try {
      const res = await fetch("/api/review-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        const data = (await res.json().catch(() => ({}))) as {
          platforms?: { platform: string; review_url: string }[];
        };
        setPlatforms(data.platforms ?? []);
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
            {/* Review-platform destinations (item 14): the API resolves the
                org's active platforms (falling back to Google); one button each. */}
            {(() => {
              const dests =
                platforms && platforms.length > 0
                  ? platforms
                  : googleReviewUrl
                  ? [{ platform: "google", review_url: googleReviewUrl }]
                  : [];
              if (dests.length === 0) {
                return (
                  <p className="text-sm text-gray-600 mt-2">
                    We&apos;re glad you were happy!
                  </p>
                );
              }
              return (
                <div className="mt-4 flex flex-col items-center gap-2">
                  {dests.map((d) => (
                    <a
                      key={d.platform}
                      href={d.review_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block bg-green-700 text-white font-semibold text-sm rounded-lg px-5 py-3 active:bg-green-800"
                    >
                      {PLATFORM_LABEL[d.platform.toLowerCase()] ??
                        `Leave a ${d.platform} review`}
                    </a>
                  ))}
                </div>
              );
            })()}
          </>
        ) : (
          <p className="text-lg font-semibold text-gray-900">
            Thank you - the office will follow up.
          </p>
        )}
        {/* Referral prompt (item 17): the link credits the referrer — /api/leads
            resolves ?ref= (this review token) to this customer. */}
        {leadFormToken && (
          <p className="text-sm text-gray-600 mt-5">
            Know someone who needs lawn care?{" "}
            <a
              href={`/lead/${leadFormToken}?ref=${encodeURIComponent(token)}`}
              className="text-green-700 font-semibold underline"
            >
              Refer them here
            </a>
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
          Glad to hear it! Would you mind leaving us a public review?
        </p>
      )}

      {/* Optional photo attach (item 16) — sent base64 in the POST body. */}
      {rating != null && (
        <div className="space-y-1">
          <label className="block text-xs font-semibold text-gray-700">
            {photoName
              ? `Photo attached: ${photoName}`
              : "Add a photo (optional)"}
          </label>
          <input
            type="file"
            accept="image/jpeg,image/png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) {
                setPhotoB64(null);
                setPhotoName(null);
                return;
              }
              if (file.size > 2_500_000) {
                setError("Photo is too large (max 2.5 MB).");
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const result = String(reader.result ?? "");
                setPhotoB64(result.split(",")[1] ?? null);
                setPhotoName(file.name);
              };
              reader.readAsDataURL(file);
            }}
            className="text-xs text-gray-600"
          />
        </div>
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