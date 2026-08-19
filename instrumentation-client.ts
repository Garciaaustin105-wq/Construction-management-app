// Client-side Sentry init. Next 15+ loads this file automatically in the
// browser bundle (the counterpart to the server-side instrumentation.ts).
// DSN is hardcoded — Sentry DSNs are public identifiers (they ship in client
// JS bundles by design), NOT secrets; only SENTRY_AUTH_TOKEN is a secret and
// stays in env. Errors flow to Sentry on every deploy.
//
// Session replays are DISABLED (replaysSessionSampleRate AND
// replaysOnErrorSampleRate both 0). Replays capture DOM + user input, which is
// hard to scrub reliably in a multi-tenant app with customer portals that take
// typed names, emails, and signatures. Enable deliberately only after a PII
// review of every captured surface.
//
// No perf tracing (tracesSampleRate: 0) — spans carry request URLs that could
// leak portal tokens; the scrubber redacts them but no-tracing removes the path
// entirely. Logs disabled (we don't use Sentry.logger; avoids accidental PII).

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/sentry";

Sentry.init({
  dsn: "https://9e9b5d01e79ca426a500856fb656e44c@o4511935727796224.ingest.us.sentry.io/4511935756304384",
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  enableLogs: false,
  beforeSend: scrubEvent,
  ignoreErrors: [
    // Browser noise we never want to triage.
    "top-level container is not a video element",
    "Non-Error promise rejection captured",
    "ResizeObserver loop completed with delievered notifications",
    "ResizeObserver loop limit exceeded",
  ],
});

// Instrument client-side route transitions (App Router).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;