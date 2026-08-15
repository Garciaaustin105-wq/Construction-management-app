// Central brand config — the PLATFORM / product name. This is what every
// tenant sees regardless of org: the login screen, app chrome, PWA install
// name, and platform notification emails (verify-email, password reset).
//
// This is NOT used for the document issuer on invoices/estimates — that is the
// tenant's own org name (organizations.name), resolved per-document. Keeping
// these separate prevents one tenant's company name from appearing on another
// tenant's customer-facing documents. See estimates/[id]/page.tsx,
// api/estimates/[id]/send/route.ts, and q/[token]/page.tsx for the issuer logic.

export const BRAND = {
  /** Full product name — browser tab title, PWA install screen. */
  name: "Terra Vista Construction Management App",
  /** Short name for tight spaces — app icon, email subject prefix. */
  shortName: "Terra Vista",
  /** Customer-facing platform name — email footers ("via ..."). */
  company: "Terra Vista Construction Management",
  /** One-line descriptor. */
  tagline: "Field-to-office construction management",
} as const;