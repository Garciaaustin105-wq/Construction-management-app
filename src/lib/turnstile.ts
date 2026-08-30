// Cloudflare Turnstile server-side verification. Free CAPTCHA replacement —
// see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/.
// Used by /api/signup, which creates accounts via the admin API rather than
// supabase.auth.signUp(), so it can't rely on Supabase's built-in
// `options: { captchaToken }` handling the way /login's signInWithPassword
// does — this route has to call Turnstile's siteverify endpoint itself.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  token: string | undefined | null,
  remoteIp: string | null
): Promise<{ success: boolean; error?: string }> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Not configured yet — fail OPEN (don't block signups) but the caller
    // logs this distinctly from a real verification failure so it's obvious
    // in Sentry that captcha isn't actually protecting anything yet.
    return { success: true, error: "not_configured" };
  }
  if (!token) {
    return { success: false, error: "missing_token" };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(VERIFY_URL, { method: "POST", body });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!data.success) {
      return { success: false, error: (data["error-codes"] ?? []).join(",") || "verify_failed" };
    }
    return { success: true };
  } catch {
    return { success: false, error: "network_error" };
  }
}
