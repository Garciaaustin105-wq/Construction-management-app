import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { sendSubmittalEmail } from "@/lib/email";
import { loadSubmittalForEmail } from "@/lib/emailLoaders";
import { OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office/PM hits Send → deliver the submittal to the reviewer (architect/owner)
// and mark it submitted. The reviewer's email is supplied in the request body
// (there is no architect entity; the office types it). Mints a fresh
// share_token (rotates), flips status draft → submitted, stamps sent_at, sets
// ball_in_court='architect', and emails a /s/{token} portal link. The reviewer
// returns a disposition at the portal, which flips it to 'returned' + ball back
// to 'office' (see /api/submittals/by-token/[token]/return). The caller must be
// office/admin/PM; the service role is used only for the delivery + the write.
//
// "submitted means delivered": if the email fails the submittal is NOT marked
// submitted and the error is returned.

function requestHost(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  if (xfhost) return xfhost;
  const hostHeader = request.headers.get("host");
  if (hostHeader) return hostHeader;
  try {
    return new URL(request.url).host;
  } catch {
    return "localhost";
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let to = "";
  let message: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.to === "string") to = body.to.trim();
    if (typeof body?.message === "string") message = body.message;
  } catch {
    // No body / invalid JSON → to stays "".
  }
  if (!to) {
    return NextResponse.json(
      { error: "Enter the reviewer's email to send this submittal." },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.role || !OFFICE_OR_PM.has(profile.role as never)) {
    return NextResponse.json({ error: "Office or PM only" }, { status: 403 });
  }

  // Submittal + job name. Row load + field mapping live in src/lib/emailLoaders.ts
  // (loadSubmittalForEmail) and are SHARED with the /admin/email-preview "preview
  // with real data" feature so a preview matches what ships. The reviewer's email
  // (`to`) is caller-supplied (no architect entity) — it is NOT loaded here.
  const loaded = await loadSubmittalForEmail(supabase, id);

  if (!loaded) {
    return NextResponse.json({ error: "Submittal not found" }, { status: 404 });
  }

  if (loaded.status !== "draft" && loaded.status !== "returned") {
    return NextResponse.json(
      { error: `This submittal is already ${loaded.status}` },
      { status: 400 }
    );
  }

  const token = crypto.randomUUID();
  const host = requestHost(request);
  const scheme = host.startsWith("localhost") ? "http" : "https";
  const submittalUrl = `${scheme}://${host}/s/${token}`;

  const { error: emailError } = await sendSubmittalEmail({
    to,
    orgName: loaded.orgName,
    jobName: loaded.jobName,
    submittalNumber: loaded.submittalNumber,
    title: loaded.title,
    csiSection: loaded.csiSection,
    submittalUrl,
    message,
  });

  if (emailError) {
    return NextResponse.json(
      { error: `Email failed: ${emailError.message}. Check RESEND_API_KEY / RESEND_FROM.` },
      { status: 502 }
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { error: updateError } = await admin
    .from("submittals")
    .update({
      status: "submitted",
      sent_at: new Date().toISOString(),
      share_token: token,
      ball_in_court: "architect",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json(
      {
        error: `Email delivered, but failed to mark the submittal submitted: ${updateError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, sentTo: { email: to } });
}