import type { CSSProperties } from "react";
import type { Metadata, Viewport } from "next";
import { Fraunces, Public_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import { BRAND } from "@/lib/brand";
import { isLawn } from "@/lib/variant";
import { getMe } from "@/lib/tenant";
import type { Role } from "@/lib/roles";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import GoogleTag from "@/components/GoogleTag";
import AttributionCapture from "@/components/AttributionCapture";

// Brand color vars set per-deploy on <html> so the --brand/--brand-dark/
// --brand-bg CSS vars (and their bg-brand/text-brand Tailwind utilities) resolve
// to the variant's color with no per-file branching. Construction deploy = blue,
// lawn deploy = green. See src/lib/brand.ts + src/app/globals.css.
const brandVars = {
  "--brand": BRAND.themeColor,
  "--brand-dark": BRAND.themeColorDark,
  "--brand-bg": BRAND.brandBg,
} as CSSProperties;

// Typefaces for the lawn (Terra Verde) redesign. Three roles, deliberately:
// Fraunces carries page/card titles, Public Sans carries UI and body, and IBM
// Plex Mono carries KPI values and currency so digits align in a column
// (tabular figures) instead of shimmying as numbers change.
//
// `variable:` mode only DEFINES a CSS custom property — it does not apply a
// font-family to anything. So these are inert until a .variable class is put on
// an element, which is what makes the variant gate below airtight.
//
// Loader calls must be module-scope constants (next/font is a build-time
// transform, so they cannot sit inside the component or behind an `if`). The
// gate is therefore on APPLICATION, not declaration: `fontClasses` is the empty
// string in the construction build, so construction renders no font vars, gets
// no <link rel=preload>, and keeps its system-stack chrome exactly as-is. It
// pays for a few unreferenced font files in the build output; that is the price
// of a static import and it changes nothing a user sees.
const fraunces = Fraunces({ subsets: ["latin"], display: "swap", variable: "--font-fraunces" });
const publicSans = Public_Sans({ subsets: ["latin"], display: "swap", variable: "--font-public-sans" });
// IBM Plex Mono is a static family, so next/font requires explicit weights.
// 500 for KPI values, 600 for the rare emphasized figure.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600"],
  variable: "--font-plex-mono",
});

const fontClasses = isLawn()
  ? `${fraunces.variable} ${publicSans.variable} ${plexMono.variable}`
  : "";

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: BRAND.iconPath,
    shortcut: BRAND.iconPath,
    apple: { url: BRAND.appleIconPath, sizes: "180x180" },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: BRAND.shortName,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: BRAND.themeColor,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Read the profile role on the server so the client chrome (Sidebar +
  // BottomNav) paints with the real role on its FIRST frame — eliminating the
  // cold-load null→resolved nav flash (wrong tabs for one frame). Best-effort:
  // any failure yields null, which the client useRole store refreshes anyway.
  //
  // Uses the request-scoped cached `getMe()` so this read is SHARED with every
  // server page/route in the same request — each used to re-run getUser() +
  // profiles on top of this. (Tier 1 perf fix.) The Suspense/PPR static-shell
  // unlock is deferred (would reintroduce the cold-load nav flash).
  let initialRole: Role | null = null;
  let initialOrgId: string | null = null;
  try {
    const me = await getMe();
    initialRole = me ? ((me.role as Role) ?? null) : null;
    // Same cached read — no extra query. Feeds CrewTrackingMount.
    initialOrgId = me?.orgId ?? null;
  } catch {
    initialRole = null;
    initialOrgId = null;
  }

  return (
    // data-variant is what scopes the lawn palette in globals.css. APP_VARIANT
    // is a build-time constant, so the construction bundle emits the literal
    // `undefined` (attribute omitted) and its :root tokens are untouched.
    <html
      lang="en"
      className={`h-full antialiased ${fontClasses}`.trimEnd()}
      data-variant={isLawn() ? "lawn" : undefined}
      style={brandVars}
    >
      {/* bg-surface-muted / text-foreground resolve to #f9fafb / #111827 in
          construction — byte-identical to the bg-gray-50 text-gray-900 they
          replace — and to the warm paper + warm ink under data-variant=lawn. */}
      <body className="min-h-full bg-surface-muted text-foreground">
        <Providers initialRole={initialRole} initialOrgId={initialOrgId}>
          {children}
        </Providers>
        {/* Vercel Speed Insights — real-user perf monitoring (RUM). No-op in
            dev; only reports in production deploys. No env var needed; tied to
            the Vercel project. Measures the Tier 1 auth-preamble win. */}
        <SpeedInsights />
        {/* Vercel Web Analytics — page views per route. Same shape as
            SpeedInsights above: a no-op in dev, reports only from production
            deploys, no env var, scoped to the Vercel project. Two projects
            build from this tree, so lawn and construction report separately.

            It records the Next ROUTE, not the resolved URL — /lawn/estimate/[id]
            rather than the id — so estimate and customer ids do not leave the
            app. Worth re-checking against Vercel's docs if that ever stops
            being true, because this is a multi-tenant app with a live customer
            on it. */}
        <Analytics />
        {/* Google Ads tag (no-op until NEXT_PUBLIC_GOOGLE_ADS_ID is set) +
            utm_* capture for signup source attribution. See src/lib/gtag.ts
            and src/lib/attribution.ts. */}
        <GoogleTag />
        <AttributionCapture />
      </body>
    </html>
  );
}
