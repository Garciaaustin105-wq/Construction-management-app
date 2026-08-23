// Server-only read of an org's declared business types.
//
// Split out from ./businessTypes.ts because that module is imported by the
// SIGNUP FORM, which is a client component. Importing `@/lib/supabase/server`
// there pulls `next/headers` into the browser bundle and hard-fails the build.
// Constants, labels, and the parser stay client-safe in ./businessTypes.ts;
// anything touching the database lives here.

import { createClient } from "@/lib/supabase/server";
import { parseBusinessTypes, type BusinessType } from "@/lib/businessTypes";

/**
 * The org's declared business types.
 *
 * Returns [] when the org has none — which also covers the window before
 * business_types.sql has been run, since the select errors on the missing
 * column and callers then see "nothing declared" rather than throwing. Every
 * caller must therefore treat [] as "unknown", never as "no business": gate
 * features so that an empty result hides an addition rather than removing
 * something that already works.
 */
export async function getBusinessTypes(
  organizationId: string | null
): Promise<BusinessType[]> {
  if (!organizationId) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("business_types")
    .eq("id", organizationId)
    .maybeSingle();
  return parseBusinessTypes(data?.business_types);
}
