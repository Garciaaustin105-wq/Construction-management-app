import { createAdminClient } from "@/lib/supabase/admin";

// Shared, cross-instance rate limiting. Backed by the `rate_limits` table +
// `check_rate_limit` RPC (see the rate_limits migration).
//
// WHY NOT AN IN-MEMORY MAP: the old limiters used a module-level `new Map()`,
// which on Vercel is per-serverless-instance and ephemeral — concurrent
// requests hit different instances (each with its own empty map) and instances
// recycle constantly, so the real limit was roughly `max x instance count` and
// reset unpredictably. Postgres is already this app's shared state, so it gives
// a true shared counter with no new vendor / bill / env var.
//
// FAILS OPEN. If the limiter backend errors we allow the request. A database
// hiccup must never stop a customer from paying an invoice — the limiter is
// abuse protection, not an authorization control. Every real auth/ownership
// check lives elsewhere and is unaffected.
//
// CLIENT IP: callers pass a key built from `clientIp(request)`. On Vercel
// `x-forwarded-for` is trustworthy — Vercel OVERWRITES it at the edge and does
// not forward external IPs, specifically to prevent spoofing (see
// https://vercel.com/docs/headers/request-headers). If this app is ever moved
// off Vercel or placed behind another proxy, revisit clientIp() below.

export type RateLimitResult = {
  allowed: boolean;
  /** Hits left in the current window (0 once the cap is reached). */
  remaining: number;
  /** When the current window rolls over; null if the backend was unreachable. */
  resetAt: string | null;
  /** True when the limiter itself failed and the request was allowed through. */
  degraded: boolean;
};

/**
 * Resolve the client IP for rate-limit keying.
 *
 * On Vercel `x-forwarded-for` holds the real client IP and cannot be spoofed
 * (Vercel overwrites the header at the edge). `x-real-ip` is documented as
 * identical and is used as a fallback. Requests with neither header collapse
 * into a single shared "unknown" bucket — deliberately conservative, since the
 * alternative (a unique bucket per unidentifiable caller) is no limit at all.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/**
 * Increment the counter for `key` and report whether the caller is within
 * `max` hits per `windowSeconds`. The `max`-th request is still allowed; the
 * one after it is denied.
 */
export async function checkRateLimit(
  key: string,
  max: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .rpc("check_rate_limit", {
        p_key: key,
        p_max: max,
        p_window_seconds: windowSeconds,
      })
      .maybeSingle();

    if (error || !data) {
      return { allowed: true, remaining: max, resetAt: null, degraded: true };
    }

    const row = data as {
      allowed: boolean;
      remaining: number;
      reset_at: string;
    };
    return {
      allowed: row.allowed,
      remaining: row.remaining ?? 0,
      resetAt: row.reset_at ?? null,
      degraded: false,
    };
  } catch {
    // Network/config failure — fail open (see header note).
    return { allowed: true, remaining: max, resetAt: null, degraded: true };
  }
}

/**
 * Convenience wrapper: check several keys at once (e.g. per-IP AND per-token)
 * and deny if ANY of them is over its cap. Checks run in parallel; every key is
 * incremented regardless of which one trips, so a caller cannot dodge the token
 * limit by rotating IPs.
 */
export async function checkRateLimits(
  limits: Array<{ key: string; max: number; windowSeconds: number }>
): Promise<RateLimitResult> {
  const results = await Promise.all(
    limits.map((l) => checkRateLimit(l.key, l.max, l.windowSeconds))
  );
  const denied = results.find((r) => !r.allowed);
  if (denied) return denied;
  // All allowed — report the tightest remaining budget.
  return results.reduce((acc, r) => (r.remaining < acc.remaining ? r : acc));
}

/** Standard 429 body + Retry-After. Deliberately leaks nothing about the target. */
export function rateLimitResponse(result: RateLimitResult): Response {
  const retryAfterSec = result.resetAt
    ? Math.max(1, Math.ceil((Date.parse(result.resetAt) - Date.now()) / 1000))
    : 60;
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again shortly." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
      },
    }
  );
}
