// Edge-runtime Sentry init (proxy.ts + edge API routes). Loaded by
// instrumentation.ts when NEXT_RUNTIME === "edge". INERT until SENTRY_DSN is
// set. Same scrubbing + no-tracing policy as the server config.

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/sentry";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  ignoreErrors: [
    "Non-Error promise rejection captured",
  ],
});