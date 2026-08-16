import type { CSSProperties } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";
import { BRAND } from "@/lib/brand";

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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased" style={brandVars}>
      <body className="min-h-full bg-gray-50 text-gray-900">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
