// Signup source attribution — captures utm_* params (+ referrer) from the URL
// a visitor first arrives on, and carries them through to the /api/signup
// payload so a new org row records which channel it came from. Without this,
// there is no way to compare Google Ads cost-per-signup against organic (see
// GOOGLE_ADS_PHASE2_CAMPAIGN.md Section 0 and the marketing plan's Section 7
// KPI: "community-sourced signups... via UTM per channel").
//
// Session-scoped (sessionStorage), not first-touch-forever: a fresh utm_*
// querystring always overwrites the stored value (so a Google Ads click mid-
// session gets credit over stale organic attribution), but navigating the
// site WITHOUT utm params (e.g. clicking "Start free" from the homepage)
// preserves whatever was captured on landing, since the querystring doesn't
// survive that link.

const STORAGE_KEY = "tv_attribution";
const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

export type SignupAttribution = Partial<Record<(typeof UTM_KEYS)[number], string>> & {
  referrer?: string;
};

/** Client-only. Reads the current URL's querystring and, if it carries any
 *  utm_* param, stores it (+ document.referrer) as the active attribution for
 *  this browser session. Safe to call on every page load. */
export function captureAttributionFromUrl(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const found: SignupAttribution = {};
  for (const key of UTM_KEYS) {
    const v = params.get(key);
    if (v) found[key] = v.slice(0, 255);
  }
  if (Object.keys(found).length === 0) return;
  if (document.referrer) found.referrer = document.referrer.slice(0, 255);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(found));
  } catch {
    // Private browsing / storage disabled — attribution is best-effort only.
  }
}

/** Client-only. Returns the attribution captured earlier this session, or
 *  null if none was ever recorded (direct visit, no campaign link). */
export function getStoredAttribution(): SignupAttribution | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SignupAttribution) : null;
  } catch {
    return null;
  }
}
