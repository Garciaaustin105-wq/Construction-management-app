import { createClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import MapLink from "@/components/MapLink";
import JobAssignment from "@/components/JobAssignment";
import JobStatusControl from "@/components/JobStatusControl";
import RfiAnswerForm from "@/components/RfiAnswerForm";
import BlueprintsSection from "@/components/BlueprintsSection";
import PhotoLightbox from "@/components/PhotoLightbox";
import ActivityTimeline from "@/components/ActivityTimeline";
import DeleteJobButton from "@/components/DeleteJobButton";
import JobFinancials from "@/components/JobFinancials";
import JobBudget from "@/components/JobBudget";
import ReceiptsSection from "@/components/ReceiptsSection";
import StatusBadge from "@/components/StatusBadge";
import { Camera, CornerDownRight } from "lucide-react";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? "crew";

  // Fan out all per-job reads in parallel (was sequential awaits, so the job
  // page waited on job → photos → rfis → blueprints → receipts → crew).
  const [jobRes, photosRes, rfisRes, blueprintsRes, receiptsRes, crewRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, name, address, description, status, created_at, assigned_crew, customers(name)")
      .eq("id", id)
      .single(),
    supabase
      .from("photos")
      .select(
        "id, storage_path, caption, created_at, uploaded_by, lat, lng, uploader:profiles(full_name)"
      )
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("rfis")
      .select("id, question, answer, status, created_at, answered_at")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("blueprints")
      .select("id, storage_path, filename, caption, created_at")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("receipts")
      .select(
        "id, storage_path, vendor, amount, notes, captured_at, uploaded_by, uploaded_by_name, reimbursed, reimbursed_at, category, tax, payment_method, receipt_no, cost_code_id"
      )
      .eq("job_id", id)
      .order("captured_at", { ascending: false }),
    role === "office"
      ? supabase
          .from("profiles")
          .select("id, full_name, email")
          .eq("role", "crew")
          .order("full_name")
      : Promise.resolve({ data: [] }),
  ]);

  const job = jobRes.data;
  if (!job) notFound();
  const photos = photosRes.data;
  const rfis = rfisRes.data;
  const blueprints = blueprintsRes.data;
  const receipts = receiptsRes.data;
  const crewMembers = crewRes.data;

  // Mark this job as viewed (fire-and-forget; doesn't block render)
  void supabase
    .from("job_views")
    .upsert(
      { user_id: user.id, job_id: id, last_seen_at: new Date().toISOString() },
      { onConflict: "user_id,job_id" }
    );

  // Flatten the joined uploader name for the lightbox. Office can read all
  // profiles (RLS), so this resolves for office; crew RLS only returns their
  // own profile, so coworker names come back null — the lightbox handles that.
  const photosForLightbox = (photos ?? []).map((p) => ({
    id: p.id,
    storage_path: p.storage_path,
    caption: p.caption,
    created_at: p.created_at,
    lat: p.lat ?? null,
    lng: p.lng ?? null,
    uploaded_by_name:
      (p.uploader as unknown as { full_name: string | null } | null)?.full_name ??
      null,
  }));

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title={job.name} subtitle={(job.customers as unknown as { name: string } | null)?.name ?? ""} />

      <main className="max-w-md mx-auto p-4 space-y-6">
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="mb-2">
            <StatusBadge status={job.status} />
          </div>
          {job.address && <MapLink address={job.address} />}
          {job.description && (
            <p className="text-sm text-gray-600 mt-2">{job.description}</p>
          )}
        </section>

        {/* Office only: assign crew */}
        {role === "office" && (
          <JobAssignment
            jobId={job.id}
            initialAssigned={job.assigned_crew ?? []}
            crewMembers={crewMembers ?? []}
          />
        )}

        {/* Office only: change job status */}
        {role === "office" && (
          <JobStatusControl jobId={job.id} currentStatus={job.status} />
        )}

        {/* Crew + office: upload photo button (customers have no upload policy -> hide) */}
        {role !== "customer" && (
          <div className="grid grid-cols-1 gap-2">
            <Link
              href={`/crew/photo?job=${job.id}`}
              className="bg-blue-600 text-white text-center py-4 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
            >
              <Camera className="w-5 h-5" />
              Upload Photo
            </Link>
          </div>
        )}

        {/* Photos */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
            Photos ({photos?.length ?? 0})
          </h2>
          {photos && photos.length > 0 ? (
            <PhotoLightbox photos={photosForLightbox} canDelete={role === "office"} />
          ) : (
            <div className="bg-white rounded-lg py-8 flex flex-col items-center text-center">
              <div className="w-12 h-12 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-2">
                <Camera className="w-6 h-6" />
              </div>
              <p className="text-sm font-medium text-gray-900">No photos yet</p>
              <p className="text-xs text-gray-500 mt-1 max-w-xs">
                Tap &ldquo;Upload Photo&rdquo; above to capture progress from the field.
              </p>
            </div>
          )}
        </section>

        {/* Receipts — office and assigned crew */}
        {(role === "office" || (job.assigned_crew ?? []).includes(user.id)) && (
          <ReceiptsSection
            jobId={job.id}
            jobName={job.name}
            role={role}
            remoteReceipts={receipts ?? []}
          />
        )}

        {/* Blueprints — visible to office, crew, and customer */}
        <BlueprintsSection
          jobId={job.id}
          blueprints={blueprints ?? []}
          role={role}
        />

        <ActivityTimeline job={job} photos={photos ?? []} rfis={rfis ?? []} />

        {/* Quotes & Invoices — office sees all, customer sees only their own */}
        <JobFinancials jobId={job.id} role={role} />

        {/* Budget vs Actual — office only */}
        {role === "office" && <JobBudget jobId={job.id} />}

        {/* RFIs — office and assigned crew */}
        {(role === "office" || (job.assigned_crew ?? []).includes(user.id)) && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
              RFIs ({rfis?.length ?? 0})
            </h2>
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {rfis?.map((r) => (
                <div key={r.id} className="p-3">
                  <p className="text-sm text-gray-900">{r.question}</p>
                  {r.answer && (
                    <p className="text-sm text-green-700 mt-1 bg-green-50 p-2 rounded flex items-start gap-1">
                      <CornerDownRight className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>{r.answer}</span>
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    <span className="font-medium">{r.status}</span> ·{" "}
                    {new Date(r.created_at).toLocaleDateString()}
                  </p>
                  {/* Office can answer open RFIs */}
                  {r.status === "open" && <RfiAnswerForm rfiId={r.id} />}
                </div>
              ))}
              {(!rfis || rfis.length === 0) && (
                <div className="py-6 text-center">
                  <p className="text-sm text-gray-500">No RFIs yet</p>
                  <p className="text-xs text-gray-400 mt-1">
                    Questions submitted from the field will appear here.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Office only: delete project */}
        {role === "office" && (
          <DeleteJobButton jobId={job.id} jobName={job.name} />
        )}
      </main>

    </div>
  );
}