import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Share a receipt with the office: uploads the stamped image to the private
// `receipts` bucket and inserts a `receipts` row, using the service role so we
// don't depend on per-crew storage RLS policies. The caller must be office or
// assigned to the job — validated server-side.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const form = await request.formData();
  const jobId = String(form.get("jobId") ?? "");
  const capturedAt = String(form.get("capturedAt") ?? "");
  const vendor = (form.get("vendor") as string | null) || null;
  const amountRaw = form.get("amount");
  const amount =
    amountRaw === null || amountRaw === "" || amountRaw === "null"
      ? null
      : Number(amountRaw);
  const notes = (form.get("notes") as string | null) || null;
  const file = form.get("file") as File | null;

  if (!jobId || !capturedAt || !file) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Caller's profile (role + name)
  const { data: profile } = await admin
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";

  // Validate assignment
  const { data: job } = await admin
    .from("jobs")
    .select("assigned_crew")
    .eq("id", jobId)
    .single();
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  const assigned = (job.assigned_crew ?? []) as string[];
  if (role !== "office" && !assigned.includes(user.id)) {
    return NextResponse.json({ error: "Not assigned to this job" }, { status: 403 });
  }

  // Upload to the private receipts bucket (service role bypasses storage RLS)
  const path = `${jobId}/${Date.now()}.jpg`;
  const { error: upErr } = await admin.storage
    .from("receipts")
    .upload(path, file, { contentType: "image/jpeg" });
  if (upErr) {
    return NextResponse.json(
      { error: `Upload failed: ${upErr.message}` },
      { status: 500 }
    );
  }

  // Insert the receipts row (service role bypasses row RLS)
  const { data, error: dbErr } = await admin
    .from("receipts")
    .insert({
      job_id: jobId,
      uploaded_by: user.id,
      uploaded_by_name: profile?.full_name ?? null,
      storage_path: path,
      vendor,
      amount: typeof amount === "number" && !Number.isNaN(amount) ? amount : null,
      notes,
      captured_at: capturedAt,
    })
    .select("id")
    .single();
  if (dbErr || !data) {
    // Roll back the storage upload so we don't leave an orphaned file
    await admin.storage.from("receipts").remove([path]);
    return NextResponse.json(
      { error: `Save failed: ${dbErr?.message ?? "error"}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ id: data.id, storagePath: path });
}