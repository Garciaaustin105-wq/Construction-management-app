import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Allow access from the local network IP during development
  // so the app works when accessed from phones on the same WiFi.
  allowedDevOrigins: ["192.168.4.69", "localhost", "127.0.0.1"],
};

// Sentry build-time wrapper. org/project are the real Sentry project (the DSN
// is public-safe; committed in the config files). authToken is read from env —
// source-map upload only fires when SENTRY_AUTH_TOKEN is set (locally via
// .env.sentry-build-plugin, or on Vercel), so builds still pass without it (you
// just get minified stack traces until it's added). tunnelRoute proxies browser
// events through our server to dodge ad-blockers. See [[lowvoltage-sentry-scaffold]].
export default withSentryConfig(nextConfig, {
  org: "terra-vista-building-and-devel",
  project: "javascript-nextjs",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Route Sentry event requests through our own server (avoids ad-blockers).
  tunnelRoute: "/sentry-tunnel",
  silent: true,
  widenClientFileUpload: true,
  // v10 moved source-map options under `sourcemaps`. deleteSourcemapsAfterUpload
  // defaults to true (the old hideSourceMaps behavior), so no override needed.
  // (disableLogger was removed — deprecated in v10; enableLogs:false in the
  // client config already keeps Sentry.logger inert.)
});
