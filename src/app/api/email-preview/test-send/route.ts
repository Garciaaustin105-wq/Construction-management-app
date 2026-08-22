import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { isOfficeLike } from "@/lib/roles";
import { getKind, type RenderCtx } from "@/lib/emailPreview";

export const dynamic = "force-dynamic";

// Send a test of a customer-facing email to the SIGNED-IN USER'S OWN email —
// never to a customer, never to an arbitrary address. The office uses this to
// see exactly how a given email lands in a real inbox (formatting, subject,
// sender, spam placement) before trusting the live send path.
//
// Auth: office/admin/super_admin (isOfficeLike). The destination is locked to
// user.email from the session — the request body has NO `to` field on purpose,
// so a caller cannot redirect a test send to someone else. For templated kinds,
// the live-edited subject/body (if provided) is what gets sent, so "what you
// see is what you send." For fixed-copy kinds the sample data is used.
//
// Body: { id, editedSubject?: string, editedBody?: string }
// Response: { ok: boolean, sentTo?: string, error?: string }

type TestSendBody = {
  id?: string;
  editedSubject?: string;
  editedBody?: string;
  recordId?: string;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const user = me.user;

  const role = (me.hasProfile ? me.role : null);
  if (!isOfficeLike(role)) {
    return NextResponse.json(
      { error: "Office or admin only" },
      { status: 403 }
    );
  }

  // Lock the destination to the signed-in user's own email. Auth users always
  // have an email; guard anyway.
  const toEmail = user.email?.trim();
  if (!toEmail) {
    return NextResponse.json(
      { error: "Your account has no email on file to send a test to." },
      { status: 400 }
    );
  }

  let body: TestSendBody = {};
  try {
    body = (await request.json()) as TestSendBody;
  } catch {
    // No body — send the saved-template / fixed-sample version.
  }
  const kind = typeof body.id === "string" ? getKind(body.id) : undefined;
  if (!kind) {
    return NextResponse.json({ error: "Unknown email kind" }, { status: 400 });
  }

  const organizationId = me.orgId;
  let orgName = "";
  if (organizationId) {
    const { data: org } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .maybeSingle();
    if (org?.name) orgName = org.name as string;
  }

  const ctx: RenderCtx = {
    supabase,
    organizationId: organizationId ?? "",
    orgName,
    editedSubject: body.editedSubject,
    editedBody: body.editedBody,
    recordId: body.recordId,
  };

  const res = await kind.sendTest(toEmail, ctx);
  if (res.error) {
    // Non-fatal: surface the provider message (e.g. "email not configured")
    // without a 500 so the UI can toast it.
    return NextResponse.json(
      { ok: false, error: res.error.message },
      { status: 200 }
    );
  }
  return NextResponse.json({ ok: true, sentTo: toEmail });
}