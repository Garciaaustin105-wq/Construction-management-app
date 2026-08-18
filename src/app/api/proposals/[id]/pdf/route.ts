import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_OR_PM, type Role } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office view of the signed proposal PDF. The signed PDF lives in the private
// `proposal-docs` bucket (service-role-only writes), so the office can't fetch
// it directly — this route mints a short-lived signed URL (1h) and 302-
// redirects. Office-gated (OFFICE_OR_PM); the estimate is read via RLS so a
// cross-org office user can't pull another org's signed proposal. Falls back to
// the most recent portal_approvals.signed_pdf_path if estimates.signed_proposal_url
// is somehow blank.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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
  const role = profile?.role as Role | null;
  if (!role || !OFFICE_OR_PM.has(role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // RLS-scoped read: only a same-org estimate the office can see comes back.
  const { data: est } = await supabase
    .from("estimates")
    .select("signed_proposal_url")
    .eq("id", id)
    .maybeSingle();
  let path = (est?.signed_proposal_url as string | null) ?? null;

  if (!path) {
    // Fallback: latest portal_approvals row for this estimate (service role —
    // portal_approvals has its own office RLS, but the join on document_id is
    // simplest server-side).
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: approval } = await admin
      .from("portal_approvals")
      .select("signed_pdf_path")
      .eq("document_type", "estimate")
      .eq("document_id", id)
      .order("signed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    path = (approval?.signed_pdf_path as string | null) ?? null;
  }

  if (!path) {
    return NextResponse.json(
      { error: "No signed proposal PDF on file." },
      { status: 404 }
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data, error } = await admin.storage
    .from("proposal-docs")
    .createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { error: "Failed to generate a link to the signed proposal." },
      { status: 500 }
    );
  }
  return NextResponse.redirect(data.signedUrl);
}