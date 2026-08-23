// White-label logo renderer for app chrome. Shows the org's uploaded logo
// when one is set, otherwise falls back to the platform icon. Imported by the
// client Sidebar/TopBar; pure presentational (no hooks, no "use client" needed).

import { BRAND } from "@/lib/brand";

type OrgLogoProps = {
  logoUrl: string | null;
  alt: string;
  size?: number;
  className?: string;
  /** When the org has no uploaded logo, render the platform's FULL wordmark
   *  logo (BRAND.logoPath — the same image the sign-in page shows) at a
   *  height-constrained auto width, instead of the square icon. Used by the
   *  TopBar, which has no separate brand text label, so the in-app header
   *  matches the sign-in page rather than dropping to the bare icon mark.
   *  The Sidebar keeps the default icon fallback because it already shows the
   *  org / platform short name as text beside the icon. */
  wordmarkFallback?: boolean;
};

export default function OrgLogo({
  logoUrl,
  alt,
  size = 28,
  className,
  wordmarkFallback = false,
}: OrgLogoProps) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={alt}
        width={size}
        height={size}
        className={`shrink-0 rounded-md object-contain ${className ?? ""}`}
      />
    );
  }
  if (wordmarkFallback) {
    // Height-constrained with auto width to preserve the wordmark's aspect
    // ratio (logoPath SVGs are ~4:1). Forcing width=height would squash the
    // wordmark text into a square.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={BRAND.logoPath}
        alt={alt}
        style={{ height: size, width: "auto" }}
        className={`shrink-0 object-contain ${className ?? ""}`}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={BRAND.iconPath}
      alt={alt}
      width={size}
      height={size}
      className={`shrink-0 rounded-md ${className ?? ""}`}
    />
  );
}