import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Allow access from the local network IP during development
  // so the app works when accessed from phones on the same WiFi.
  allowedDevOrigins: ["192.168.4.69", "localhost", "127.0.0.1"],
};

// Sentry build-time wrapper. Source-map upload only fires when SENTRY_AUTH_TOKEN
// is present (it isn't locally or until the user wires Sentry env vars), so this
// is INERT in the meantime — it just passes nextConfig through. org/project are
// read from env so nothing is hardcoded. See [[lowvoltage-sentry-scaffold]].
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  disableLogger: true,
  // v10 moved source-map options under `sourcemaps`. deleteSourcemapsAfterUpload
  // defaults to true (the old hideSourceMaps behavior), so no override needed.
});
