import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

export function getEnvVar(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
}

export const dynamic = "force-dynamic";

// Delete a shared receipt: removes the storage object and the row, using the
// service role (bypasses storage RLS). Only office or the original uploader
// may delete a shared receipt — validated server-side.
export async function DELETE(
  request: Request,
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

  const admin = createAdminClient(
    getEnvVar("NEXT_PUBLIC_SUPABASE_URL"),
    getEnvVar("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: receipt } = await admin
    .from("receipts")
    .select("storage_path, uploaded_by, organization_id")
    .eq("id", id)
    .single();
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";
  const callerOrg = (profile?.organization_id as string | null) ?? null;
  const receiptOrg = (receipt.organization_id as string | null) ?? null;

  // Service-role delete bypasses RLS, so enforce the org boundary here:
  // only same-org office/admin or the original uploader (same org) may delete.
  // super_admin bypasses.
  if (!isSuperAdmin(role)) {
    if (!callerOrg || callerOrg !== receiptOrg) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    if (!isOfficeLike(role) && receipt.uploaded_by !== user.id) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
  }

  await admin.storage.from("receipts").remove([receipt.storage_path]);
  const { error } = await admin.from("receipts").delete().eq("id", id);
  if (error) {
    return NextResponse.json(
      { error: `Delete failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}