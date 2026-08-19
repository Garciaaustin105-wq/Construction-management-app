import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import { FIELD_MGMT } from "@/lib/roles";
import Link from "next/link";
import { Plus, FileText, Download } from "lucide-react";
import SubmittalFilters from "@/components/SubmittalFilters";

type Row = {
  id: string;
  submittal_number: string | null;
  title: string;
  csi_section: string | null;
  status: string;
  disposition: string | null;
  ball_in_court: string;
  created_at: string;
  jobs: { name: string } | null;
};

function statusCls(s: string): string {
  if (s === "closed") return "bg-green-100 text-green-700";
  if (s === "returned") return "bg-amber-100 text-amber-800";
  if (s === "submitted") return "bg-blue-100 text-blue-600";
  return "bg-gray-100 text-gray-600";
}

export default async function SubmittalsPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string }>;
}) {
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
  // Field-management review: superintendent + PM + office + admin/super_admin.
  // Authoring (canCreate) stays office/admin.
  if (!FIELD_MGMT.has(role)) redirect("/dashboard");
  const canCreate = role === "office" || role === "admin";

  const sp = await searchParams;
  const jobFilter = sp.job ?? "";
  const statusFilter = sp.status ?? "";

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name")
    .order("name");

  let q = supabase
    .from("submittals")
    .select(
      "id, submittal_number, title, csi_section, status, disposition, ball_in_court, created_at, jobs(name)"
    )
    .order("created_at", { ascending: false });
  if (jobFilter) q = q.eq("job_id", jobFilter);
  if (statusFilter) q = q.eq("status", statusFilter);
  const { data: rowsRaw } = await q;
  const rows = (rowsRaw ?? []) as unknown as Row[];

  const exportHref = `/api/reports/submittals?${jobFilter ? `job=${jobFilter}` : ""}${
    statusFilter ? `&status=${statusFilter}` : ""
  }`.replace(/^\/api\/reports\/submittals\?&/, "/api/reports/submittals?");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Submittals" subtitle="Submittal log & review" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <SubmittalFilters
          jobs={jobs ?? []}
          currentJob={jobFilter}
          currentStatus={statusFilter}
        />
        {canCreate && (
          <Link
            href="/submittals/new"
            className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" /> New Submittal
          </Link>
        )}
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center">
            <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No submittals yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
              Track submittals to architects, owners, and reviewers.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/submittals/${r.id}`}
                className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {r.submittal_number ? `${r.submittal_number} · ` : ""}
                      {r.title}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {r.jobs?.name ?? ""}
                      {r.csi_section ? ` · ${r.csi_section}` : ""}
                      {` · ${new Date(r.created_at).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusCls(
                        r.status
                      )}`}
                    >
                      {r.status}
                    </span>
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        r.ball_in_court === "architect"
                          ? "bg-indigo-100 text-indigo-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {r.ball_in_court === "architect" ? "Architect" : "Office"}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
        {rows.length > 0 && (
          <Link
            href={exportHref}
            className="block bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" /> Export Excel
          </Link>
        )}
      </main>
    </div>
  );
}