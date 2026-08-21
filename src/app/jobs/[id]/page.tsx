import { createClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import JobDetailsEditor from "@/components/JobDetailsEditor";
import JobCustomerAssignment from "@/components/JobCustomerAssignment";
import JobAssignment from "@/components/JobAssignment";
import JobStatusControl from "@/components/JobStatusControl";
import RfiAnswerForm from "@/components/RfiAnswerForm";
import BlueprintsSection from "@/components/BlueprintsSection";
import PhotoLightbox from "@/components/PhotoLightbox";
import ActivityTimeline from "@/components/ActivityTimeline";
import DeleteJobButton from "@/components/DeleteJobButton";
import JobFinancials from "@/components/JobFinancials";
import JobBudget from "@/components/JobBudget";
import JobGanttInspectionsSummary from "@/components/JobGanttInspectionsSummary";
import ReceiptsSection from "@/components/ReceiptsSection";
import JobSubcontractors, {
  type JobSub,
} from "@/components/JobSubcontractors";
import ScheduleEventsManager, {
  type ScheduleEvent,
} from "@/components/ScheduleEventsManager";
import StatusBadge from "@/components/StatusBadge";
import { Camera, CornerDownRight } from "lucide-react";
import { MANAGEMENT, OFFICE_OR_PM, isOfficeLike } from "@/lib/roles";
import { formatMoney } from "@/lib/money";

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
  const [jobRes, photosRes, rfisRes, blueprintsRes, receiptsRes, crewRes, customersRes, jobSubsRes, allSubsRes, schedEventsRes, dailyLogsRes, punchRes, changeOrdersRes, submittalsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, name, address, description, status, created_at, assigned_crew, customer_id, customers(name), type")
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
    OFFICE_OR_PM.has(role)
      ? supabase
          .from("profiles")
          .select("id, full_name, email, role")
          .in("role", ["crew", "superintendent"])
          .order("full_name")
      : Promise.resolve({ data: [] }),
    // Customer picker options — office/PM only (matches who can edit the
    // assignment below). "Management read customers" RLS (tier_management)
    // covers office/admin/PM/superintendent, so this always resolves for
    // whoever the UI actually shows the picker to.
    OFFICE_OR_PM.has(role)
      ? supabase.from("customers").select("id, name").order("name")
      : Promise.resolve({ data: [] }),
    // Subcontractors attached to this job — management only.
    MANAGEMENT.has(role)
      ? supabase
          .from("job_subcontractors")
          .select(
            "subcontractor_id, role_on_job, scheduled_date, subcontractor:subcontractors(id, company, trade, phone, email)"
          )
          .eq("job_id", id)
      : Promise.resolve({ data: [] }),
    MANAGEMENT.has(role)
      ? supabase
          .from("subcontractors")
          .select("id, company")
          .order("company")
      : Promise.resolve({ data: [] }),
    // Schedule events — readable by management (all), assigned crew, and the
    // owning customer (RLS enforces). Ordered by start time.
    supabase
      .from("schedule_events")
      .select("id, title, start_at, end_at, kind, notes")
      .eq("job_id", id)
      .order("start_at", { ascending: true }),
    // Daily logs — office + assigned crew (customers have no RLS read, so the
    // query is skipped for them). RLS scopes the rest.
    role !== "customer"
      ? supabase
          .from("daily_logs")
          .select(
            "id, log_date, weather, status, created_at, created_by, creator:profiles!created_by(full_name)"
          )
          .eq("job_id", id)
          .order("log_date", { ascending: false })
      : Promise.resolve({ data: [] }),
    // Punch items — office + assigned crew + customer (RLS). Skipped for
    // customer here as the job-page section is office/crew only in v1.
    role !== "customer"
      ? supabase
          .from("punch_items")
          .select(
            "id, title, location, status, priority, due_date, assigned_to, assignee:profiles!assigned_to(full_name)"
          )
          .eq("job_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    // Change orders — office/PM only (management read exists at RLS but the
    // job-page section is gated to office/PM).
    OFFICE_OR_PM.has(role)
      ? supabase
          .from("change_orders")
          .select(
            "id, co_number, title, amount, is_credit, status, sent_at, viewed_at, created_at"
          )
          .eq("job_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    // Submittals — office/PM only on the job page (crew/customer read exists
    // at RLS but isn't surfaced here in v1).
    OFFICE_OR_PM.has(role)
      ? supabase
          .from("submittals")
          .select(
            "id, submittal_number, title, csi_section, status, disposition, ball_in_court, created_at"
          )
          .eq("job_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const job = jobRes.data;
  if (!job) notFound();

  // Lawn jobs don't exist in the construction app (construction is
  // construction-only; /lawn is blocked there). The lawn variant never reaches
  // /jobs/[id] (the proxy blocks /jobs in that variant), so this branch only
  // runs in construction — surface a 404 rather than bouncing to a blocked
  // /lawn route.
  if ((job as unknown as { type?: string }).type === "lawn") {
    notFound();
  }
  const photos = photosRes.data;
  const rfis = rfisRes.data;
  const blueprints = blueprintsRes.data;
  const receipts = receiptsRes.data;
  const crewMembers = crewRes.data;
  const customerOptions = (customersRes.data ?? []) as { id: string; name: string }[];

  // Flatten attached subcontractors for the JobSubcontractors section.
  const jobSubs: JobSub[] = ((jobSubsRes.data ?? []) as unknown as {
    subcontractor_id: string;
    role_on_job: string | null;
    scheduled_date: string | null;
    subcontractor: {
      id: string;
      company: string;
      trade: string | null;
      phone: string | null;
      email: string | null;
    } | null;
  }[])
    .map((r) => {
      const s = r.subcontractor;
      return {
        subcontractor_id: r.subcontractor_id,
        company: s?.company ?? "—",
        trade: s?.trade ?? null,
        phone: s?.phone ?? null,
        email: s?.email ?? null,
        role_on_job: r.role_on_job,
        scheduled_date: r.scheduled_date,
      };
    });
  const allSubs = (allSubsRes.data ?? []) as { id: string; company: string }[];
  const schedEvents = (schedEventsRes.data ?? []) as ScheduleEvent[];
  const dailyLogs = (dailyLogsRes.data ?? []) as unknown as {
    id: string;
    log_date: string;
    weather: string | null;
    status: string;
    created_at: string;
    creator: { full_name: string | null } | null;
  }[];
  const punchItems = (punchRes.data ?? []) as unknown as {
    id: string;
    title: string;
    location: string | null;
    status: string;
    priority: string;
    due_date: string | null;
    assignee: { full_name: string | null } | null;
  }[];
  const changeOrders = (changeOrdersRes.data ?? []) as {
    id: string;
    co_number: string | null;
    title: string;
    amount: number;
    is_credit: boolean;
    status: string;
    created_at: string;
  }[];
  const submittals = (submittalsRes.data ?? []) as {
    id: string;
    submittal_number: string | null;
    title: string;
    csi_section: string | null;
    status: string;
    disposition: string | null;
    ball_in_court: string;
    created_at: string;
  }[];

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
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title={job.name} subtitle={(job.customers as unknown as { name: string } | null)?.name ?? ""} />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-6">
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <div className="mb-2">
            <StatusBadge status={job.status} />
          </div>
          <JobDetailsEditor
            jobId={job.id}
            initialName={job.name}
            initialAddress={job.address}
            initialDescription={job.description}
            canEdit={OFFICE_OR_PM.has(role)}
          />
        </section>

        {/* Office + project manager: set/change the customer linked to this
            job. This was previously only settable at job creation
            (/admin/projects/new) — there was no way to attach or reassign a
            customer on an existing job afterward. */}
        {OFFICE_OR_PM.has(role) && (
          <JobCustomerAssignment
            jobId={job.id}
            initialCustomerId={job.customer_id}
            customers={customerOptions}
          />
        )}

        {/* Schedule (Gantt) + Inspections summary — all roles can view (RLS scopes
            read); office/PM edit on the dedicated pages. */}
        <JobGanttInspectionsSummary jobId={job.id} />

        {/* Office + project manager: assign crew (PM has authority over crews) */}
        {(OFFICE_OR_PM.has(role)) && (
          <JobAssignment
            jobId={job.id}
            initialAssigned={job.assigned_crew ?? []}
            crewMembers={crewMembers ?? []}
          />
        )}

        {/* Office only: change job status */}
        {isOfficeLike(role) && (
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
            <PhotoLightbox photos={photosForLightbox} canDelete={isOfficeLike(role)} />
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
        {(isOfficeLike(role) || (job.assigned_crew ?? []).includes(user.id)) && (
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

        {/* Subcontractors on this job — management reads; office + PM edit
            (RLS writes on job_subcontractors are is_office_or_pm, so PM can
            attach/manage subs on their jobs — the editor must match). */}
        {MANAGEMENT.has(role) && (
          <JobSubcontractors
            jobId={job.id}
            initial={jobSubs}
            allSubs={allSubs}
            canEdit={OFFICE_OR_PM.has(role)}
          />
        )}

        {/* Schedule events — all authorized roles see; office/PM can edit.
            RLS admits management (all), assigned crew, and owning customer. */}
        <ScheduleEventsManager
          jobId={job.id}
          initial={schedEvents}
          canEdit={OFFICE_OR_PM.has(role)}
        />

        <ActivityTimeline job={job} photos={photos ?? []} rfis={rfis ?? []} />

        {/* Estimates & Invoices — office sees all, customer sees only their own */}
        <JobFinancials jobId={job.id} role={role} />

        {/* Budget vs Actual — office only */}
        {isOfficeLike(role) && <JobBudget jobId={job.id} />}

        {/* Change Orders — office/PM */}
        {OFFICE_OR_PM.has(role) && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase">
                Change Orders ({changeOrders.length})
              </h2>
              <Link
                href={`/change-orders/new?job=${job.id}`}
                className="text-xs text-blue-600 font-medium"
              >
                + New
              </Link>
            </div>
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {changeOrders.map((c) => {
                const amt = Number(c.amount) || 0;
                const statusCls =
                  c.status === "approved"
                    ? "bg-green-100 text-green-700"
                    : c.status === "rejected"
                    ? "bg-red-100 text-red-700"
                    : c.status === "sent" || c.status === "submitted"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-700";
                return (
                  <Link
                    key={c.id}
                    href={`/change-orders/${c.id}`}
                    className="block p-3 active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {c.co_number ? `${c.co_number} · ` : ""}
                          {c.title}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(c.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={`text-sm font-semibold ${
                            c.is_credit ? "text-red-600" : "text-gray-900"
                          }`}
                        >
                          {c.is_credit ? "-" : ""}
                          {formatMoney(amt)}
                        </span>
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusCls}`}
                        >
                          {c.status}
                        </span>
                      </div>
                    </div>
                  </Link>
                );
              })}
              {changeOrders.length === 0 && (
                <div className="py-6 text-center">
                  <p className="text-sm text-gray-500">No change orders yet</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Submittals — office/PM */}
        {OFFICE_OR_PM.has(role) && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase">
                Submittals ({submittals.length})
              </h2>
              <Link
                href={`/submittals/new?job=${job.id}`}
                className="text-xs text-blue-600 font-medium"
              >
                + New
              </Link>
            </div>
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {submittals.map((s) => {
                const statusCls =
                  s.status === "closed"
                    ? "bg-green-100 text-green-700"
                    : s.status === "returned"
                    ? "bg-amber-100 text-amber-800"
                    : s.status === "submitted"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-700";
                return (
                  <Link
                    key={s.id}
                    href={`/submittals/${s.id}`}
                    className="block p-3 active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {s.submittal_number ? `${s.submittal_number} · ` : ""}
                          {s.title}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {s.csi_section ? `${s.csi_section} · ` : ""}Ball:{" "}
                          {s.ball_in_court}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusCls}`}
                      >
                        {s.status}
                      </span>
                    </div>
                  </Link>
                );
              })}
              {submittals.length === 0 && (
                <div className="py-6 text-center">
                  <p className="text-sm text-gray-500">No submittals yet</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* RFIs — office and assigned crew */}
        {(isOfficeLike(role) || (job.assigned_crew ?? []).includes(user.id)) && (
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

        {/* Daily Logs — office and assigned crew */}
        {(isOfficeLike(role) || (job.assigned_crew ?? []).includes(user.id)) && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase">
                Daily Logs ({dailyLogs.length})
              </h2>
              {OFFICE_OR_PM.has(role) && (
                <Link
                  href={`/daily-logs/new?job=${job.id}`}
                  className="text-xs text-blue-600 font-medium"
                >
                  + New
                </Link>
              )}
            </div>
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {dailyLogs.map((l) => (
                <Link
                  key={l.id}
                  href={`/daily-logs/${l.id}`}
                  className="block p-3 active:bg-gray-50"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {new Date(l.log_date).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {l.weather ?? "No weather noted"}
                        {l.creator?.full_name ? ` · ${l.creator.full_name}` : ""}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        l.status === "reviewed"
                          ? "bg-green-100 text-green-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {l.status}
                    </span>
                  </div>
                </Link>
              ))}
              {dailyLogs.length === 0 && (
                <div className="py-6 text-center">
                  <p className="text-sm text-gray-500">No daily logs yet</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Punch List — office and assigned crew */}
        {(isOfficeLike(role) || (job.assigned_crew ?? []).includes(user.id)) && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-500 uppercase">
                Punch List ({punchItems.length})
              </h2>
              {OFFICE_OR_PM.has(role) && (
                <Link
                  href={`/punch/new?job=${job.id}`}
                  className="text-xs text-blue-600 font-medium"
                >
                  + New
                </Link>
              )}
            </div>
            <div className="bg-white rounded-lg shadow-sm divide-y">
              {punchItems.map((p) => {
                const statusCls =
                  p.status === "complete"
                    ? "bg-green-100 text-green-700"
                    : p.status === "in_progress"
                    ? "bg-amber-100 text-amber-800"
                    : p.status === "void"
                    ? "bg-gray-100 text-gray-500"
                    : "bg-gray-100 text-gray-700";
                return (
                  <Link
                    key={p.id}
                    href={`/punch/${p.id}`}
                    className="block p-3 active:bg-gray-50"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {p.title}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {p.location ? `${p.location} · ` : ""}
                          {p.assignee?.full_name ?? "Unassigned"}
                          {p.due_date
                            ? ` · due ${new Date(p.due_date).toLocaleDateString()}`
                            : ""}
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusCls}`}
                      >
                        {p.status.replace("_", " ")}
                      </span>
                    </div>
                  </Link>
                );
              })}
              {punchItems.length === 0 && (
                <div className="py-6 text-center">
                  <p className="text-sm text-gray-500">No punch items yet</p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Office only: export + delete project */}
        {isOfficeLike(role) && (
          <>
            <a
              href={`/api/jobs/${job.id}/export`}
              className="block w-full text-center bg-gray-100 text-gray-800 py-3 rounded-lg font-semibold active:bg-gray-200"
            >
              Export job profile (ZIP)
            </a>
            <p className="text-xs text-gray-400 text-center -mt-2 px-4">
              Download all files + records for this job before removing it (e.g. to fit a lower plan).
            </p>
            <DeleteJobButton jobId={job.id} jobName={job.name} />
          </>
        )}
      </main>

    </div>
  );
}