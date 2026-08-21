import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { isOfficeLike } from "@/lib/roles";
import { getKind, type RenderCtx } from "@/lib/emailPreview";

export const dynamic = "force-dynamic";

// Preview a customer-facing email as { subject, html }. POSTed (not GET) so the
// office can pass a live-edited subject/body for templated kinds and we never
// bump into URL length limits on keystroke-driven previews.
//
// Auth: office/admin/super_admin (isOfficeLike). The session client scopes the
// notification_templates read to the caller's own org (RLS), so a preview never
// leaks another tenant's saved wording. super_admin has a null org → templated
// kinds render the "no template saved" placeholder (they have no org templates
// to preview); fixed-copy kinds render normally.
//
// Body: { id: EmailKind["id"], editedSubject?: string, editedBody?: string }
// Response: { id, label, variant, editable, tokens?, subject, html } | 4xx

type PreviewBody = {
  id?: string;
  editedSubject?: string;
  editedBody?: string;
  recordId?: string;
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role ?? null;
  if (!isOfficeLike(role)) {
    return NextResponse.json(
      { error: "Office or admin only" },
      { status: 403 }
    );
  }

  let body: PreviewBody = {};
  try {
    body = (await request.json()) as PreviewBody;
  } catch {
    // Empty body is fine (initial saved-template preview).
  }
  const kind = typeof body.id === "string" ? getKind(body.id) : undefined;
  if (!kind) {
    return NextResponse.json({ error: "Unknown email kind" }, { status: 400 });
  }

  const organizationId =
    (profile?.organization_id as string | null) ?? null;

  // Resolve the org name for branding (falls back to BRAND.company inside the
  // render fns when empty — e.g. super_admin with no org).
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

  try {
    const { subject, html, rawSubject, rawBody } = await kind.render(ctx);
    return NextResponse.json({
      id: kind.id,
      label: kind.label,
      variant: kind.variant,
      editable: kind.editable,
      tokens: kind.tokens,
      subject,
      html,
      // Raw (un-substituted) copy for editable kinds — populates the editor
      // with {{tokens}} intact. Absent for fixed-copy kinds.
      rawSubject,
      rawBody,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "render failed" },
      { status: 500 }
    );
  }
}