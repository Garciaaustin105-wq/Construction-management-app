// SMS (text) notifications are NOT live yet — the Twilio env vars
// (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER, plus A2P 10DLC
// approval for US long codes) are not configured on either Vercel project.
//
// This is the single client-visible source of truth for every SMS-facing UI
// control. When SMS_ENABLED is false, each SMS surface (the Notifications
// template rows, the per-customer Text opt-in, and the estimate/invoice Send
// "Text" / "Both" channel buttons) renders a "Coming soon" treatment and is
// non-interactive, so the office can't dead-click an option that won't deliver.
//
// To turn SMS on once Twilio is configured on BOTH Vercel projects: flip this to
// true, commit, and push (both apps auto-deploy). The server-side sendCustomerSms
// already gates on TWILIO_* env, so nothing sends before that regardless.
export const SMS_ENABLED = false;