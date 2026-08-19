// Client-side Sentry init. Next 15+ loads this file automatically in the
// browser bundle (the counterpart to the server-side instrumentation.ts).
// INERT until NEXT_PUBLIC_SENTRY_DSN is set — with no DSN, Sentry.init no-ops
// and no events leave the browser.
//
// Session replays are DISABLED by default (replaysSessionSampleRate AND
// replaysOnErrorSampleRate both 0). Replays capture DOM + user input, which is
// hard to scrub reliably in a multi-tenant app with customer portals that take
// typed names, emails, and signatures. Enable deliberately only after a PII
// review of every captured surface.

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/sentry";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
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