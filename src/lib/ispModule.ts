// Server-side ISP/fiber module gate.
//
// The check itself (`organizations.isp_module_enabled`) was already being
// inlined in /installs and /installs/new; the billing surfaces add half a dozen
// more call sites, so it lives here once instead of being copy-pasted with
// slightly different redirect targets each time.
//
// SECURITY NOTE — the same one useIspModule.ts carries, and it matters just as
// much here: this flag gates REACHABILITY, not access. RLS on the isp_* tables
// is the real boundary, and none of those policies reference this flag. An org
// without the module that somehow reached these routes gets zero rows from RLS
// anyway. Keeping the flag out of RLS means flipping it can never become a data
// leak — so treat this as UX (don't show people a module they didn't buy),
// never as the thing standing between a tenant and someone else's data.

import { createClient } from "@/lib/supabase/server";

/** Whether the org has the hidden ISP/fiber module turned on. */
export async function isIspOrg(organizationId: string | null): Promise<boolean> {
  if (!organizationId) return false;
  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("isp_module_enabled")
    .eq("id", organizationId)
    .maybeSingle();
  // `?? false` also covers the window before isp_module.sql has been run, when
  // the column doesn't exist and the select errors — the module simply stays
  // unreachable rather than throwing.
  return (data?.isp_module_enabled as boolean | null) ?? false;
}
