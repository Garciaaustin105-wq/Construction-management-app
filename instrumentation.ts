// Next 16 server-side instrumentation hook. Loads the right Sentry config for
// the runtime (nodejs vs edge) at cold start, and exports onRequestError so
// unhandled errors in server components / route handlers / server actions are
// captured. All INERT until SENTRY_DSN is set.
//
// Client-side init lives in instrumentation-client.ts (Next 15+), which Next
// loads automatically in the browser bundle — do NOT import it here (this file
// is server-only).

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Capture unhandled errors thrown in server components, route handlers, and
// server actions. Runs server-side only.
export const onRequestError = Sentry.captureRequestError;