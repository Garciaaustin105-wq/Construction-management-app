import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Frictionless submittal return — public (no auth); the share_token in the URL
// is the only credential. The reviewer (architect/owner) picks a disposition
// (approved / approved_as_noted / revise_resubmit / rejected). Service role
// because there is no user session. Guards: token must resolve + status must be
// 'submitted'. Sets status='returned', the disposition, returned_at, and
// moves ball_in_court back to 'office' so the office knows to act (close or
// resubmit). The office is notified via the in-app feed (NON-FATAL).

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  let body: { disposition?: string; note?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const validDispositions = [
    "approved",
    "approved_as_noted",
    "revise_resubmit",
    "rejected",
  ] as const;
  type Disposition = (typeof validDispositions)[number];
  const disposition = body.disposition as Disposition | undefined;
  if (!disposition || !validDispositions.includes(disposition)) {
    return NextResponse.json(
      {
        error: "disposition must be approved, approved_as_noted, revise_resubmit, or rejected",
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: submittal } = await admin
    .from("submittals")
    .select(
      "id, status, organization_id, job_id, submittal_number, title, csi_section, jobs(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!submittal) {
    return NextResponse.json({ error: "Submittal not found" }, { status: 404 });
  }
  if (submittal.status !== "submitted") {
    return NextResponse.json(
      { error: "This submittal is not awaiting action." },
      { status: 400 }
    );
  }

  const jobName =
    (submittal.jobs as unknown as { name: string } | null)?.name ??
    (submittal.title as string | null) ??
    "the project";
  const submittalNumber = (submittal.submittal_number as string | null) ?? null;

  // Record an in-app notification for the office feed. NON-FATAL — the return
  // state change already succeeded by the time this runs.
  const recordNotification = async () => {
    try {
      await admin.from("notifications").insert({
        organization_id: submittal.organization_id,
        type: "submittal_returned",
        title: "Submittal returned",
        body: [jobName, disposition.replace(/_/g, " ")].filter(Boolean).join(" · "),
        href: `/submittals/${submittal.id}`,
        entity_id: submittal.id,
      });
    } catch {
      // Swallow — feed is best-effort.
    }
  };

  const now = new Date().toISOString();
  const { error } = await admin
    .from("submittals")
    .update({
      status: "returned",
      disposition,
      returned_at: now,
      ball_in_court: "office",
      updated_at: now,
    })
    .eq("id", submittal.id);
  if (error) {
    return NextResponse.json(
      { error: `Failed: ${error.message}` },
      { status: 500 }
    );
  }

  await recordNotification();

  return NextResponse.json({ ok: true, status: "returned", disposition });
}