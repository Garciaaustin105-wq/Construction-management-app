// Edge-runtime Sentry init (proxy.ts + edge API routes). Loaded by
// instrumentation.ts when NEXT_RUNTIME === "edge". DSN hardcoded (public-safe;
// see sentry.server.config.ts). Same scrubbing + no-tracing policy as server.

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/sentry";

Sentry.init({
  dsn: "https://9e9b5d01e79ca426a500856fb656e44c@o4511935727796224.ingest.us.sentry.io/4511935756304384",
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  ignoreErrors: [
    "Non-Error promise rejection captured",
  ],
});