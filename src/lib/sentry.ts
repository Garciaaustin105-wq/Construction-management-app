// Sentry event scrubber + captureException re-export.
//
// This is the security-critical piece of the Sentry integration: a single
// `scrubEvent` used by every Sentry.init's `beforeSend` (client, server, edge)
// so NOTHING that looks like a credential, and NO raw request body, ever leaves
// the app for Sentry. This is non-negotiable for a multi-tenant app that handles
// auth headers, Stripe keys, customer PII, and portal tokens.
//
// The integration stays INERT until SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN are set
// on the Vercel projects: with no DSN, Sentry.init no-ops and no events are
// sent, so the scrubber simply never runs. See [[lowvoltage-sentry-scaffold]].

import { captureException as sentryCaptureException } from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";

// Key names whose values must never be sent. Matched case-insensitively
// against header names, `extra` keys, breadcrumb data keys, and context keys.
// Covers Supabase auth, Stripe, portal bearer tokens, and generic secrets.
const SECRET_KEY =
  /authorization|apikey|api[-_]?key|token|secret|password|passwd|cookie|stripe|supabase/i;

const REDACTED = "[REDACTED]";

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY.test(k)) {
      out[k] = REDACTED;
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
 * request bodies and cookies entirely (form fields / JSON payloads / query
 * strings can all carry PII or credentials we never want in Sentry).
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