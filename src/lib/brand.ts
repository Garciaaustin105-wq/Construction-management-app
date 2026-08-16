// Central brand config — the PLATFORM / product name. This is what every
// tenant sees regardless of org: the login screen, app chrome, PWA install
// name, and platform notification emails (verify-email, password reset).
//
// This is NOT used for the document issuer on invoices/estimates — that is the
// tenant's own org name (organizations.name), resolved per-document. Keeping
// these separate prevents one tenant's company name from appearing on another
// tenant's customer-facing documents. See estimates/[id]/page.tsx,
// api/estimates/[id]/send/route.ts, and q/[token]/page.tsx for the issuer logic.
//
// BRAND is variant-aware (APP_VARIANT): the same repo builds two apps —
// "Terra Vista Construction Management" (construction/default, blue) and
// "Terra Verde Lawn Management" (lawn, green). The theme colors + logo/icon
// paths here feed the runtime CSS vars (--brand/--brand-dark/--brand-bg) set in
// the root layout, so identity surfaces (chrome, auth pages, customer docs,
// emails) recolor per deploy with no per-file branching. Internal in-app
// buttons keep Tailwind blue-600 for v1. See src/lib/variant.ts.

import { APP_VARIANT, isLawn, isConstruction, type AppVariant } from "@/lib/variant";

type BrandConfig = {
  /** Full product name — browser tab title, PWA install screen. */
  name: string;
  /** Short name for tight spaces — app icon, email subject prefix. */
  shortName: string;
  /** Customer-facing platform name — email footers ("via ..."). */
  company: string;
  /** One-line descriptor. */
  tagline: string;
  /** Primary brand color (hex) — theme-color meta, focus outline, CTAs. */
  themeColor: string;
  /** Darker brand color — doc/email headers. */
  themeColorDark: string;
  /** Light brand tint — active backgrounds (replaces blue-50). */
  brandBg: string;
  /** Full logo path (auth/marketing pages). */
  logoPath: string;
  /** Square icon path (chrome fallback, manifest SVG entry, error pages). */
  iconPath: string;
  /** 180×180 PNG — iOS apple-touch-icon (rasterized from iconPath SVG). */
  appleIconPath: string;
  /** 192×192 PNG — Android/PWA manifest (rasterized from iconPath SVG). */
  icon192Path: string;
  /** 512×512 PNG — Android/PWA manifest hi-res (rasterized from iconPath SVG). */
  icon512Path: string;
};

const CONSTRUCTION: BrandConfig = {
  name: "Terra Vista Construction Management App",
  shortName: "Terra Vista",
  company: "Terra Vista Construction Management",
  tagline: "Field-to-office construction management",
  themeColor: "#2563eb",
  themeColorDark: "#1e3a8a",
  brandBg: "#dbeafe",
  logoPath: "/terra-vista-logo.svg",
  iconPath: "/terra-vista-icon.svg",
  appleIconPath: "/apple-icon.png",
  icon192Path: "/icon-192.png",
  icon512Path: "/icon-512.png",
};

const LAWN: BrandConfig = {
  name: "Terra Verde Lawn Management",
  shortName: "Terra Verde",
  company: "Terra Verde Lawn Management",
  tagline: "Lawn maintenance, routes & billing",
  themeColor: "#15803d",
  themeColorDark: "#166534",
  brandBg: "#dcfce7",
  logoPath: "/terra-verde-logo.svg",
  iconPath: "/terra-verde-icon.svg",
  appleIconPath: "/terra-verde-apple-icon.png",
  icon192Path: "/terra-verde-icon-192.png",
  icon512Path: "/terra-verde-icon-512.png",
};

const CONFIGS: Record<AppVariant, BrandConfig> = {
  construction: CONSTRUCTION,
  lawn: LAWN,
};

export const BRAND: BrandConfig = CONFIGS[APP_VARIANT];

/** Re-export for convenience so callers don't all import variant.ts separately. */
export { isLawn, isConstruction };