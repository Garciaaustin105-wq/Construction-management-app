// What kind of business an org is — the runtime, multi-valued answer.
//
// Distinct from the two things it is easy to confuse it with:
//
//   app_variant        BUILD-TIME, one of {construction, lawn}, per deploy.
//                      Answers "which app did they sign up through" and drives
//                      the proxy's cross-variant route blocking. Single-valued
//                      by nature — see src/lib/variant.ts.
//   isp_module_enabled Per-org boolean gating the ISP/fiber module's surfaces.
//                      Still the module gate; business type does not replace it.
//
// `business_types` describes the BUSINESS: an org can be construction + isp at
// once (Terra Vista is), which neither of the above can express. Captured at
// signup, editable later by an org admin.
//
// CLIENT-SAFE: this module must stay free of server-only imports — the signup
// form (a client component) imports BUSINESS_TYPES/labels from here, and
// pulling in `@/lib/supabase/server` would drag `next/headers` into the browser
// bundle and fail the build. The server-side read lives in
// ./businessTypes.server.ts for exactly that reason.
//
// Deliberately NOT an authorization mechanism. Like isp_module_enabled, this is
// UI shaping only — RLS is what protects data, and no policy references this
// column. Keeping it out of RLS means editing it can never become a data leak.

export const BUSINESS_TYPES = ["construction", "lawn", "isp"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  construction: "Construction / contracting",
  lawn: "Lawn & landscaping",
  isp: "Internet / fiber (ISP)",
};

/** Narrow arbitrary input to the known set, dropping anything unrecognized. */
export function parseBusinessTypes(input: unknown): BusinessType[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<BusinessType>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().toLowerCase();
    if ((BUSINESS_TYPES as readonly string[]).includes(v)) {
      seen.add(v as BusinessType);
    }
  }
  return [...seen];
}

/** Does this org do the given kind of work? */
export function hasBusinessType(
  types: BusinessType[],
  type: BusinessType
): boolean {
  return types.includes(type);
}
