import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOfficeLike } from "@/lib/roles";
import { NextResponse } from "next/server";
import { PassThrough, Readable } from "stream";
import { ZipArchive } from "archiver";

// Download a whole job profile as a ZIP — the "keep your data" companion to the
// downgrade guard (Part 2). When an office has to trim jobs to fit a lower tier,
// they can export each job here first so deleting it isn't data loss: the ZIP
// carries the original files (photos/blueprints/submittal files/receipts/signed
// proposal) plus a JSON summary of every record attached to the job.
//
// Gated to office-like roles (matches the Delete button on the job page — the
// same audience that removes jobs). Files live in private / service-role-write
// buckets (proposal-docs, submittal-files), so storage downloads use the admin
// client; the metadata reads use the RLS session client, which already scopes
// to the caller's own org (a cross-org job id returns null → 404).
//
// Slug is `jobId` to match the sibling `api/jobs/[jobId]/view` route — Next.js
// forbids two different slug names under the same dynamic path.

export const dynamic = "force-dynamic";

function safeName(name: string): string {
  // Strip path separators + control chars so the zip filename + the
  // Content-Disposition can't be clobbered or escape the files/ tree.
  return (name || "job").replace(/[^a-z0-9\-_ ]/gi, "").trim().slice(0, 60) || "job";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = me.user;

  const role = me.role;
  if (!isOfficeLike(role)) {
    return NextResponse.json({ error: "Office access required" }, { status: 403 });
  }

  // Fetch the job + every attached record (RLS scopes to the caller's org).
  const [jobRes, photosRes, blueprintsRes, receiptsRes, estimatesRes, invoicesRes, rfisRes, dailyLogsRes, punchRes, changeOrdersRes, submittalsRes, submittalFilesRes, schedEventsRes, approvalsRes, lawnVisitsRes, lawnSchedulesRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, name, address, description, status, type, created_at, customers(name, email, phone)")
      .eq("id", jobId)
      .maybeSingle(),
    supabase.from("photos").select("id, storage_path, caption, created_at, lat, lng, visit_id").eq("job_id", jobId),
    supabase.from("blueprints").select("id, storage_path, filename, caption, created_at").eq("job_id", jobId),
    supabase.from("receipts").select("id, storage_path, vendor, amount, tax, category, payment_method, receipt_no, captured_at").eq("job_id", jobId),
    supabase.from("estimates").select("id, status, title, created_at, estimate_line_items(id, quantity, unit_price)").eq("job_id", jobId),
    supabase.from("invoices").select("id, status, paid_at, amount_paid, created_at, invoice_line_items(id, quantity, unit_price)").eq("job_id", jobId),
    supabase.from("rfis").select("id, question, answer, status, created_at, answered_at").eq("job_id", jobId),
    supabase.from("daily_logs").select("id, log_date, weather, status, created_at").eq("job_id", jobId),
    supabase.from("punch_items").select("id, title, location, status, priority, due_date").eq("job_id", jobId),
    supabase.from("change_orders").select("id, co_number, title, amount, is_credit, status, created_at").eq("job_id", jobId),
    supabase.from("submittals").select("id, submittal_number, title, csi_section, status, disposition, ball_in_court, created_at").eq("job_id", jobId),
    supabase.from("submittal_files").select("id, submittal_id, filename, storage_path, created_at").eq("job_id", jobId),
    supabase.from("schedule_events").select("id, title, start_at, end_at, kind, notes").eq("job_id", jobId),
    supabase.from("portal_approvals").select("id, document_type, document_id, signed_pdf_path, signer_name, signed_at").eq("job_id", jobId).not("signed_pdf_path", "is", null),
    // Lawn-only record sets (empty for construction jobs — harmless). These are
    // the core of a lawn property's history: the recurring cadence + every visit.
    supabase.from("lawn_visits").select("id, recurring_schedule_id, due_date, status, crew_id, notes").eq("job_id", jobId).order("due_date", { ascending: true }),
    supabase.from("recurring_schedules").select("id, frequency, interval_weeks, days_of_week, day_of_month, start_date, end_date, service_type, price_per_visit, active, notes").eq("job_id", jobId),
  ]);

  const job = jobRes.data;
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const admin = createAdminClient();
  const jobName = safeName(job.name ?? "job");

  // Collect every (bucket, path, zipPath) we want to include, deduped by path
  // (a signed proposal referenced by multiple approvals is one file).
  const fileJobs: { bucket: string; path: string; zipPath: string }[] = [];
  const seen = new Set<string>();

  const addFile = (bucket: string, path: string | null | undefined, folder: string, filename?: string) => {
    if (!path) return;
    const key = `${bucket}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    const base = filename || path.split("/").pop() || "file";
    fileJobs.push({ bucket, path, zipPath: `files/${folder}/${safeName(base) || "file"}` });
  };

  (photosRes.data ?? []).forEach((p) => addFile("job-photos", p.storage_path, "photos", `${p.id}.jpg`));
  (blueprintsRes.data ?? []).forEach((b) => addFile("blueprints", b.storage_path, "blueprints", b.filename));
  (receiptsRes.data ?? []).forEach((r) => addFile("receipts", r.storage_path, "receipts", `${r.id}`));
  (submittalFilesRes.data ?? []).forEach((f) => addFile("submittal-files", f.storage_path, "submittal-files", f.filename));
  (approvalsRes.data ?? []).forEach((a) => addFile("proposal-docs", a.signed_pdf_path, "signed-proposals", `${a.id}.pdf`));

  const summary = {
    exported_at: new Date().toISOString(),
    exported_by: user.id,
    job,
    estimates: estimatesRes.data,
    invoices: invoicesRes.data,
    rfis: rfisRes.data,
    daily_logs: dailyLogsRes.data,
    punch_items: punchRes.data,
    change_orders: changeOrdersRes.data,
    submittals: submittalsRes.data,
    schedule_events: schedEventsRes.data,
    lawn_visits: lawnVisitsRes.data,
    recurring_schedules: lawnSchedulesRes.data,
    files_index: fileJobs.map((f) => ({ bucket: f.bucket, path: f.path, zip_path: f.zipPath })),
  };

  // Stream the ZIP straight to the response (no temp file). The archive is
  // built concurrently with the response being sent: we return the stream
  // immediately and run the download/append loop in the background so the
  // client applies backpressure WHILE files download — keeping memory bounded
  // even for a job with hundreds of photos.
  const passthrough = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", (err: Error) => {
    // Once we've started streaming we can't swap the response; destroy the
    // stream so the client sees a truncated download rather than a hang.
    passthrough.destroy(err);
  });
  archive.pipe(passthrough);

  (async () => {
    archive.append(JSON.stringify(summary, null, 2), { name: "job.json" });
    // Sequential downloads keep peak memory bounded; the client drains the
    // pipe concurrently so archiver never buffers the whole job at once.
    for (const f of fileJobs) {
      try {
        const { data, error } = await admin.storage.from(f.bucket).download(f.path);
        if (error || !data) continue;
        archive.append(Buffer.from(await data.arrayBuffer()), { name: f.zipPath });
      } catch {
        // A single missing/unreadable file shouldn't fail the whole archive —
        // skip it (it's still listed in files_index with its path).
      }
    }
    archive.finalize();
  })().catch((err: unknown) => {
    passthrough.destroy(err instanceof Error ? err : new Error(String(err)));
  });

  const webStream = Readable.toWeb(passthrough) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="job-${jobName}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}