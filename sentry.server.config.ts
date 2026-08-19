// Server-runtime Sentry init. Loaded by instrumentation.ts when
// NEXT_RUNTIME === "nodejs". DSN is hardcoded below — Sentry DSNs are public
// identifiers (they ship in client JS bundles by design), NOT secrets; only
// SENTRY_AUTH_TOKEN (source-map upload) is a secret and stays in env.
//
// No performance tracing by default (tracesSampleRate: 0) — perf data is
// high-volume, and spans carry request URLs that could leak portal tokens from
// /q/, /invoices/view/, /co/, /s/, /v/ routes. The scrubber redacts those, but
// no tracing = no spans = no URL leakage path at all. Enable deliberately only
// after a quota + PII review.

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/sentry";

Sentry.init({
  dsn: "https://9e9b5d01e79ca426a500856fb656e44c@o4511935727796224.ingest.us.sentry.io/4511935756304384",
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  ignoreErrors: [
    // Server-side noise we never want to triage.
    "Non-Error promise rejection captured",
  ],
});