// App variant switch — build-time constant driven by the NEXT_PUBLIC_APP_VARIANT
// env var.
//
// The repo ships two customer-facing apps off one codebase + one Supabase DB:
//   NEXT_PUBLIC_APP_VARIANT=construction (default, unset) → "Terra Vista
//   Construction Management" (blue) — the full GC + lawn app.
//   NEXT_PUBLIC_APP_VARIANT=lawn → "Terra Verde Lawn Management" (green) —
//   lawn-only, construction/GC-pro surfaces hidden.
//
// Each variant is a separate Vercel project (own domain + env) but the same
// repo/branch, so the variant is a build-time constant per deploy. The env is
// NEXT_PUBLIC_ prefixed so Next inlines it into BOTH server AND client bundles
// (chrome/nav/signup are client components and must see the same value as
// middleware + server pages). It is NOT runtime-switchable and not secret (just
// "lawn" vs "construction"). See src/lib/brand.ts (variant-aware brand),
// src/middleware.ts (lawn route gating), src/lib/navItems.ts (variant-aware nav).

export type AppVariant = "construction" | "lawn";

export const APP_VARIANT: AppVariant =
  process.env.NEXT_PUBLIC_APP_VARIANT === "lawn" ? "lawn" : "construction";

export const isLawn = (): boolean => APP_VARIANT === "lawn";

export const isConstruction = (): boolean => APP_VARIANT === "construction";

// Public prod URLs per variant — used by the sign-in affinity guard to send a
// user who signed into the wrong app to the correct one (auth is shared across
// both deploys via one Supabase project, but cookies are per-domain, so the only
// way into the wrong app is re-entering credentials on its /login; the guard
// catches that and bounces them to their home app). Keep in sync with the actual
// domains if they ever change.
export const APP_URLS: Record<AppVariant, string> = {
  construction: "https://terravistaconstructionmanagement.com",
  lawn: "https://terraverdelawnmanagement.com",
};