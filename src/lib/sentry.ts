// Sentry event scrubber + captureException re-export.
//
// This is the security-critical piece of the Sentry integration: a single
// `scrubEvent` used by every Sentry.init's `beforeSend` (client, server, edge)
// so NOTHING that looks like a credential, NO raw request body, and NO portal
// access token ever leaves the app for Sentry. Non-negotiable for a multi-tenant
// app that handles auth headers, Stripe keys, customer PII, and portal tokens.
//
// The DSN is hardcoded in the config files (public-safe — Sentry DSNs ship in
// client JS bundles by design; only SENTRY_AUTH_TOKEN is a secret, kept in env).
// See [[lowvoltage-sentry-scaffold]].

import { captureException as sentryCaptureException } from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";

// Key names whose values must never be sent. Matched case-insensitively
// against header names, `extra` keys, breadcrumb data keys, and context keys.
// Covers Supabase auth, Stripe, portal bearer tokens, and generic secrets.
const SECRET_KEY =
  /authorization|apikey|api[-_]?key|token|secret|password|passwd|cookie|stripe|supabase/i;

const REDACTED = "[REDACTED]";

// Public portal routes whose NEXT path segment is a bearer token granting
// access to customer data (estimates / invoices / change-orders / submittals /
// visit photos). The token segment must never reach Sentry via request.url or
// breadcrumb URLs. Keep in sync with isPublicRoute in navItems.ts.
const PORTAL_TOKEN_PREFIXES = ["/q/", "/invoices/view/", "/co/", "/s/", "/v/"];

// Breadcrumb/data keys that commonly hold URLs (navigation breadcrumbs).
const URL_KEYS = new Set(["url", "from", "to", "href", "referrer", "referer"]);

function scrubUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  // Drop the query string entirely — ?token=… (password-reset flow) and any
  // other query param can carry credentials/PII we never want in Sentry.
  let url = raw;
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) url = url.slice(0, qIdx);
  // Redact the bearer-token segment on portal routes.
  for (const prefix of PORTAL_TOKEN_PREFIXES) {
    const idx = url.indexOf(prefix);
    if (idx >= 0) {
      const start = idx + prefix.length;
      const rest = url.slice(start);
      const end = rest.indexOf("/");
      const tokenSeg = end >= 0 ? rest.slice(0, end) : rest;
      if (tokenSeg) {
        url = url.slice(0, start) + REDACTED + (end >= 0 ? rest.slice(end) : "");
      }
      break;
    }
  }
  return url;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY.test(k)) {
      out[k] = REDACTED;
    } else if (URL_KEYS.has(k) && typeof v === "string") {
      out[k] = scrubUrl(v) ?? REDACTED;
    } else if (v && typeof v === "object") {
      out[k] = Array.isArray(v)
        ? v.map((i) => (i && typeof i === "object" ? scrubObject(i as Record<string, unknown>) : i))
        : scrubObject(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * `beforeSend` shared by all three Sentry configs. Strips credential-looking
 * keys from request headers, extra, breadcrumbs, and contexts; drops raw
 * request bodies and cookies entirely; and sanitizes request/breadcrumb URLs so
 * portal bearer tokens and query strings never reach Sentry.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (!event) return event;

  if (event.request) {
    // Raw request bodies are dropped wholesale — too easy to leak a field.
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      event.request.headers = scrubObject(
        event.request.headers as unknown as Record<string, unknown>
      ) as unknown as typeof event.request.headers;
    }
    // Sanitize the URL — redacts portal token segments + strips the query.
    if (event.request.url) {
      const u = scrubUrl(event.request.url);
      if (u !== undefined) event.request.url = u;
    }
  }

  if (event.extra) {
    event.extra = scrubObject(event.extra as Record<string, unknown>);
  }

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b) => {
      if (b.data) {
        b.data = scrubObject(b.data as Record<string, unknown>) as typeof b.data;
      }
      return b;
    });
  }

  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      const ctx = event.contexts[key];
      if (ctx && typeof ctx === "object") {
        event.contexts[key] = scrubObject(
          ctx as unknown as Record<string, unknown>
        ) as unknown as (typeof event.contexts)[typeof key];
      }
    }
  }

  return event;
}

export { sentryCaptureException as captureException };