// Fires the Google Ads signup conversion. No-op until both the base tag
// (GoogleTag.tsx, gated on NEXT_PUBLIC_GOOGLE_ADS_ID) has loaded AND
// NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_CONVERSION is set to the exact "send_to"
// string Google Ads gives you for the conversion action (format:
// "AW-123456789/AbC-D_efGh12i34"), found under Tools > Conversions > your
// signup conversion action > "See tag setup" > Google tag > event snippet.

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function fireSignupConversion(): void {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  const sendTo = process.env.NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_CONVERSION;
  if (!sendTo) return;
  window.gtag("event", "conversion", { send_to: sendTo });
}
