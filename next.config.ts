import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import withBundleAnalyzer from "@next/bundle-analyzer";

// Supabase storage host for next/image remotePatterns. Derived from the same
// env var the client uses so it can never drift from the project the app talks
// to (and so preview/branch projects work without editing this file). Falls
// back to the prod host if the var is missing at config time — next.config is
// evaluated before .env is necessarily loaded in every context, and a bad
// hostname here would 400 every optimized image.
const supabaseHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;
  } catch {
    return "avmqteevisqxwmmxkrbg.supabase.co";
  }
})();

const nextConfig: NextConfig = {
  // Allow access from the local network IP during development
  // so the app works when accessed from phones on the same WiFi.
  allowedDevOrigins: ["192.168.4.69", "localhost", "127.0.0.1"],
  images: {
    // AVIF first, WebP fallback — the optimizer picks per the Accept header.
    formats: ["image/avif", "image/webp"],
    // Only PUBLIC storage objects (org logos via getPublicUrl) actually benefit
    // here: signed URLs carry a rotating token in the query string, so each
    // rotation is a fresh optimizer cache key. Signed-URL <img> tags are left
    // as plain <img> with explicit width/height + loading="lazy" instead.
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHost,
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

// Bundle analyzer — opt-in via ANALYZE=true so normal/CI builds are unaffected.
// Applied to the raw config FIRST so the Sentry wrapper still sees a plain
// NextConfig and its own webpack/turbopack plugin ordering is unchanged.
const withAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

// Sentry build-time wrapper. org/project are the real Sentry project (the DSN
// is public-safe; committed in the config files). authToken is read from env —
// source-map upload only fires when SENTRY_AUTH_TOKEN is set (locally via
// .env.sentry-build-plugin, or on Vercel), so builds still pass without it (you
// just get minified stack traces until it's added). tunnelRoute proxies browser
// events through our server to dodge ad-blockers. See [[lowvoltage-sentry-scaffold]].
export default withSentryConfig(withAnalyzer(nextConfig), {
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
