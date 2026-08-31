// Cloudflare Turnstile server-side verification. Free CAPTCHA replacement —
// see https://developers.cloudflare.com/turnstile/get-started/server-side-validation/.
// Used by /api/signup, which creates accounts via the admin API rather than
// supabase.auth.signUp(), so it can't rely on Supabase's built-in
// `options: { captchaToken }` handling the way /login's signInWithPassword
// does — this route has to call Turnstile's siteverify endpoint itself.
//
// Direct fetch to Cloudflare's siteverify endpoint, no Worker/proxy in
// between -- this app runs on Vercel (Next.js API routes), not Cloudflare
// Workers, so Wrangler-based secret management (which Cloudflare's own
// "existing widget" agent flow assumes) doesn't apply here; the secret lives
// in a plain Vercel env var like everything else in this codebase.
//
// Hostname allowlist (TURNSTILE_HOSTNAMES) and the 10s timeout mirror
// Cloudflare's own recommended hardening for this backend pattern. The
// allowlist check only runs when that env var is actually set, matching the
// existing fail-open-until-configured behavior below -- it's additional
// hardening, not a new way to hard-break signup if nobody's set it up yet.

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
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      success?: boolean;
      hostname?: string;
      "error-codes"?: string[];
    };
    if (!data.success) {
      return { success: false, error: (data["error-codes"] ?? []).join(",") || "verify_failed" };
    }
    const allowlist = (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (allowlist.length > 0 && data.hostname && !allowlist.includes(data.hostname)) {
      return { success: false, error: `hostname_mismatch:${data.hostname}` };
    }
    return { success: true };
  } catch {
    return { success: false, error: "network_error" };
  }
}
