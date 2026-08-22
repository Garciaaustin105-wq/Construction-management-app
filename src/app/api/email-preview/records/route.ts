import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { isOfficeLike } from "@/lib/roles";
import { getKind, listRecords } from "@/lib/emailPreview";

export const dynamic = "force-dynamic";

// List the real business records available for the Sample/Real picker on the
// /admin/email-preview console. The client calls this when the office switches
// a kind's toggle to "Real" so it can populate the record <select>.
//
// Auth: office/admin/super_admin (isOfficeLike). The RLS session client scopes
// the list to the caller's own org, so a super_admin (null org) gets an empty
// list — they have no org records to preview. Kinds without realData
// (password_reset / verification — auth-flow emails with no business record)
// also return empty + supportsReal:false so the client hides the toggle.
//
// Body: { id: string } (the email kind id)
// Response: { records: PickerRecord[], supportsReal: boolean } | 4xx

type RecordsBody = { id?: string };

export async function POST(request: Request) {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const role = (me.hasProfile ? me.role : null);
  if (!isOfficeLike(role)) {
    return NextResponse.json(
      { error: "Office or admin only" },
      { status: 403 }
    );
  }

  let body: RecordsBody = {};
  try {
    body = (await request.json()) as RecordsBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const kind = typeof body.id === "string" ? getKind(body.id) : undefined;
  if (!kind) {
    return NextResponse.json({ error: "Unknown email kind" }, { status: 400 });
  }

  // No realData → auth-flow email (password_reset / verification), no record
  // to pick. super_admin has a null org → no org records to preview.
  const organizationId = me.orgId;
  if (!kind.realData || !organizationId) {
    return NextResponse.json({ records: [], supportsReal: false });
  }

  const records = await listRecords(supabase, organizationId, kind.id);
  return NextResponse.json({ records, supportsReal: true });
}