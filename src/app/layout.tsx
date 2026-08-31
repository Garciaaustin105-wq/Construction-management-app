import type { CSSProperties } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";
import { BRAND } from "@/lib/brand";
import { getMe } from "@/lib/tenant";
import type { Role } from "@/lib/roles";
import { SpeedInsights } from "@vercel/speed-insights/next";
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
    <html lang="en" className="h-full antialiased" style={brandVars}>
      <body className="min-h-full bg-gray-50 text-gray-900">
        <Providers initialRole={initialRole} initialOrgId={initialOrgId}>
          {children}
        </Providers>
        {/* Vercel Speed Insights — real-user perf monitoring (RUM). No-op in
            dev; only reports in production deploys. No env var needed; tied to
            the Vercel project. Measures the Tier 1 auth-preamble win. */}
        <SpeedInsights />
        {/* Google Ads tag (no-op until NEXT_PUBLIC_GOOGLE_ADS_ID is set) +
            utm_* capture for signup source attribution. See src/lib/gtag.ts
            and src/lib/attribution.ts. */}
        <GoogleTag />
        <AttributionCapture />
      </body>
    </html>
  );
}
