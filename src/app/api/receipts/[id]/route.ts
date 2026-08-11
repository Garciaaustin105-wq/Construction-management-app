import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

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
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: receipt } = await admin
    .from("receipts")
    .select("storage_path, uploaded_by")
    .eq("id", id)
    .single();
  if (!receipt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";

  if (role !== "office" && receipt.uploaded_by !== user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
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