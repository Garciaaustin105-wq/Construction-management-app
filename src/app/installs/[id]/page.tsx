import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect, notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  MapPin,
  Package,
  StickyNote,
  Briefcase,
  Pencil,
  Phone,
  Hash,
} from "lucide-react";
import { FIELD_MGMT, OFFICE_LIKE, type Role } from "@/lib/roles";
import InstallFieldActions from "@/components/InstallFieldActions";
import InstallIssueActions from "@/components/InstallIssueActions";
import InstallPhotos from "@/components/InstallPhotos";
import InstallStatusControl from "@/components/InstallStatusControl";
import {
  statusCls,
  statusLabel,
  severityCls,
  outcomeLabel,
  money,
  whenLabel,
  humanDuration,
  totalTrackedMs,
  priorityCls,
  priorityLabel,
  type TimeEntry,
} from "@/lib/installs";

export const dynamic = "force-dynamic";

type Install = {
  id: string;
  organization_id: string;
  job_id: string | null;
  customer_id: string | null;
  title: string;
  status: string;
  price: number | string | null;
  address: string | null;
  priority: string | null;
  po_number: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_minutes: number | null;
  completion_outcome: string | null;
  has_open_problem: boolean;
  assigned_crew: string[] | null;
  notes: string | null;
  install_types: { name: string } | null;
  customers: { name: string } | null;
  jobs: { name: string } | null;
};

export default async function InstallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role as Role;
  if (role === "customer") redirect("/dashboard");

  // RLS does the real work here: a caller with no claim on this install gets
  // no row back and falls through to notFound(). The module flag is a UI gate
  // only, so it isn't re-checked per-record.
  const { data: installRaw } = await supabase
    .from("installs")
    .select(
      "id, organization_id, job_id, customer_id, title, status, price, address, priority, po_number, site_contact_name, site_contact_phone, scheduled_at, started_at, completed_at, duration_minutes, completion_outcome, has_open_problem, assigned_crew, notes, install_types(name), customers(name), jobs(name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!installRaw) notFound();
  const install = installRaw as unknown as Install;

  const [timeRes, issuesRes, notesRes, materialsRes, photosRes] =
    await Promise.all([
      supabase
        .from("install_time_entries")
        .select("id, user_id, started_at, ended_at")
        .eq("install_id", id)
        .order("started_at", { ascending: true }),
      supabase
        .from("install_issues")
        .select(
          "id, description, severity, status, created_at, resolved_at, reporter:profiles!reported_by(full_name)"
        )
        .eq("install_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("install_notes")
        .select("id, body, created_at, author:profiles!author_id(full_name)")
        .eq("install_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("install_materials")
        .select("id, name, quantity, unit, serial_number, created_at")
        .eq("install_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("photos")
        .select("id, storage_path, caption, created_at")
        .eq("install_id", id)
        .order("created_at", { ascending: false }),
    ]);

  const timeEntries = (timeRes.data ?? []) as unknown as TimeEntry[];
  const issues = (issuesRes.data ?? []) as unknown as {
    id: string;
    description: string;
    severity: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
    reporter: { full_name: string | null } | null;
  }[];
  const notes = (notesRes.data ?? []) as unknown as {
    id: string;
    body: string;
    created_at: string;
    author: { full_name: string | null } | null;
  }[];
  const materials = (materialsRes.data ?? []) as unknown as {
    id: string;
    name: string;
    quantity: number | string | null;
    unit: string | null;
    serial_number: string | null;
    created_at: string;
  }[];
  const photos = (photosRes.data ?? []) as unknown as {
    id: string;
    storage_path: string;
    caption: string | null;
    created_at: string;
  }[];

  const isOfficeSide = FIELD_MGMT.has(role);
  // Editing and resolving problems both require tier_office_or_pm at the RLS
  // layer, which is office/admin/super_admin/PM — NOT superintendent. Gating
  // the buttons on the same set means a superintendent never sees a control
  // that would fail with a permission error when pressed.
  const canEdit = OFFICE_LIKE.has(role) || role === "project_manager";
  const isAssigned = (install.assigned_crew ?? []).includes(me.user.id);
  // Office can act from the desk too (fixing a mis-tap), matching the RPCs'
  // own authorisation rule.
  const canAct = isAssigned || isOfficeSide;
  const myOpenEntry = timeEntries.find(
    (e) => e.user_id === me.user.id && !e.ended_at
  );
  const trackedMs = totalTrackedMs(timeEntries);
  const openIssues = issues.filter((i) => i.status === "open");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title={install.title} subtitle={install.install_types?.name ?? "Install"} />
      <main className="max-w-md lg:max-w-3xl mx-auto p-4 space-y-4">
        {/* Header card */}
        <section className="bg-white rounded-lg p-4 shadow-sm space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-gray-900">{install.title}</p>
              {install.customers?.name && (
                <p className="text-sm text-gray-600">{install.customers.name}</p>
              )}
            </div>
            <span
              className={`text-[11px] font-medium px-2 py-1 rounded shrink-0 ${statusCls(install.status)}`}
            >
              {statusLabel(install.status)}
            </span>
            {install.priority && install.priority !== "normal" && (
              <span
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${priorityCls(install.priority)}`}
              >
                {priorityLabel(install.priority)}
              </span>
            )}
          </div>

          {install.address && (
            <p className="text-sm text-gray-600 flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-gray-400 shrink-0" />
              {install.address}
            </p>
          )}
          {install.po_number && (
            <p className="text-sm text-gray-600 flex items-center gap-1.5">
              <Hash className="w-4 h-4 text-gray-400 shrink-0" />
              PO / ref: {install.po_number}
            </p>
          )}
          {(install.site_contact_name || install.site_contact_phone) && (
            <p className="text-sm text-gray-600 flex items-center gap-1.5">
              <Phone className="w-4 h-4 text-gray-400 shrink-0" />
              {install.site_contact_name}
              {install.site_contact_name && install.site_contact_phone ? " · " : ""}
              {install.site_contact_phone}
            </p>
          )}
          {install.jobs?.name && (
            <p className="text-sm text-gray-600 flex items-center gap-1.5">
              <Briefcase className="w-4 h-4 text-gray-400 shrink-0" />
              <Link href={`/jobs/${install.job_id}`} className="text-blue-600">
                {install.jobs.name}
              </Link>
            </p>
          )}
          {isOfficeSide && (
            <p className="text-sm font-medium text-gray-900">
              {money(install.price)}
            </p>
          )}
          {install.completion_outcome && (
            <p className="text-sm text-gray-700">
              Outcome:{" "}
              <span className="font-medium">
                {outcomeLabel(install.completion_outcome)}
              </span>
            </p>
          )}
          {canEdit && (
            <Link
              href={`/installs/${install.id}/edit`}
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600"
            >
              <Pencil className="w-4 h-4" /> Edit install
            </Link>
          )}
        </section>

        {/* Office status control — the desk can change status and mark an
            install complete with an outcome from the detail page. The shared
            component enforces the finished-status invariant. */}
        {canEdit && (
          <InstallStatusControl
            installId={install.id}
            status={install.status}
            completionOutcome={install.completion_outcome}
            canEdit={canEdit}
          />
        )}

        {/* Scheduled vs actual — the reason both are tracked */}
        <section className="bg-white rounded-lg p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4" /> Time
          </h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-gray-500">Scheduled</dt>
              <dd className="text-gray-900">{whenLabel(install.scheduled_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Expected</dt>
              <dd className="text-gray-900">
                {install.duration_minutes
                  ? humanDuration(install.duration_minutes * 60000)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Started</dt>
              <dd className="text-gray-900">{whenLabel(install.started_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Actual tracked</dt>
              <dd className="text-gray-900 font-medium">
                {humanDuration(trackedMs)}
                {myOpenEntry && (
                  <span className="ml-1 text-[10px] text-amber-700">running</span>
                )}
              </dd>
            </div>
          </dl>
          {isOfficeSide && timeEntries.length > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              {timeEntries.length} session{timeEntries.length === 1 ? "" : "s"}{" "}
              recorded
            </p>
          )}
        </section>

        {/* Crew field actions */}
        {canAct && install.status !== "cancelled" && (
          <InstallFieldActions
            installId={install.id}
            status={install.status}
            hasOpenEntry={!!myOpenEntry}
          />
        )}

        {/* Problems */}
        {issues.length > 0 && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <AlertTriangle
                className={`w-4 h-4 ${openIssues.length ? "text-red-600" : "text-gray-400"}`}
              />
              Problems
              {openIssues.length > 0 && (
                <span className="text-xs font-normal text-red-700">
                  {openIssues.length} open
                </span>
              )}
            </h2>
            <ul className="space-y-2">
              {issues.map((i) => (
                <li
                  key={i.id}
                  className={`rounded-lg border p-3 ${
                    i.status === "open"
                      ? "border-red-200 bg-red-50"
                      : "border-gray-200 bg-gray-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-gray-900">{i.description}</p>
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${severityCls(i.severity)}`}
                    >
                      {i.severity}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {i.reporter?.full_name ?? "Crew"} · {whenLabel(i.created_at)}
                    {i.status === "resolved" ? " · resolved" : ""}
                  </p>
                  {canEdit && (
                    <InstallIssueActions
                      issueId={i.id}
                      status={i.status}
                      userId={me.user.id}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Materials */}
        {materials.length > 0 && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <Package className="w-4 h-4" /> Materials used
            </h2>
            <ul className="divide-y divide-gray-100">
              {materials.map((m) => (
                <li key={m.id} className="py-2 flex justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-900">{m.name}</p>
                    {m.serial_number && (
                      <p className="text-xs text-gray-500 font-mono">
                        {m.serial_number}
                      </p>
                    )}
                  </div>
                  <span className="text-sm text-gray-700 shrink-0">
                    {m.quantity != null ? Number(m.quantity) : ""}
                    {m.unit ? ` ${m.unit}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Photos */}
        <InstallPhotos photos={photos} />

        {/* Field notes */}
        {notes.length > 0 && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <StickyNote className="w-4 h-4" /> Field notes
            </h2>
            <ul className="space-y-3">
              {notes.map((n) => (
                <li key={n.id}>
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">
                    {n.body}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {n.author?.full_name ?? "Crew"} · {whenLabel(n.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Office notes (read-only for crew) */}
        {install.notes && (
          <section className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">
              Office notes
            </h2>
            <p className="text-sm text-gray-700 whitespace-pre-wrap">
              {install.notes}
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
