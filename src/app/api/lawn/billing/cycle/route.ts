import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { OFFICE_LIKE } from "@/lib/roles";
import { runCycleBilling } from "@/lib/lawnBilling";

// On-demand monthly cycle billing (office/dispatcher). Generates one invoice
// per customer from their done-but-unbilled lawn visits, marks the visits
// billed (invoice_id), and returns a summary. Runs as the signed-in office user
// (RLS-enforced) — the same path the nightly cron uses but under the user's
// permissions. See src/lib/lawnBilling.ts for the claim-then-line flow.

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) {
    return NextResponse.json({ error: "Office only" }, { status: 403 });
  }

  const result = await runCycleBilling(supabase);
  return NextResponse.json({ ok: true, ...result });
}