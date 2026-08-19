// Server-runtime Sentry init. Loaded by instrumentation.ts when
// NEXT_RUNTIME === "nodejs". INERT until SENTRY_DSN is set (the SDK no-ops
// with no DSN, so this is safe to ship ahead of the env vars).
//
// No performance tracing by default (tracesSampleRate: 0) — perf data is
// high-volume and the free tier is 5K errors/mo, not transactions. Enable
// per-environment only after a deliberate quota/PII review.

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/sentry";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  ignoreErrors: [
    // Server-side noise we never want to triage.
    "Non-Error promise rejection captured",
  ],
});