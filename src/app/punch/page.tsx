import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import { OFFICE_OR_PM } from "@/lib/roles";
import Link from "next/link";
import { Plus, CheckSquare } from "lucide-react";
import PunchFilters from "@/components/PunchFilters";
import PunchExportButton from "@/components/PunchExportButton";

type Row = {
  id: string;
  title: string;
  location: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  jobs: { name: string } | null;
  assignee: { full_name: string | null } | null;
};

function statusCls(s: string): string {
  if (s === "complete") return "bg-green-100 text-green-700";
  if (s === "in_progress") return "bg-amber-100 text-amber-800";
  if (s === "void") return "bg-gray-100 text-gray-500";
  return "bg-gray-100 text-gray-700";
}
function priorityCls(p: string): string {
  if (p === "high") return "bg-red-100 text-red-700";
  if (p === "low") return "bg-gray-50 text-gray-500";
  return "bg-gray-100 text-gray-700";
}

export default async function PunchPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string; status?: string; priority?: string }>;
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
  if (!OFFICE_OR_PM.has(role)) redirect("/dashboard");
  const canCreate = role === "office" || role === "admin";

  const sp = await searchParams;
  const jobFilter = sp.job ?? "";
  const statusFilter = sp.status ?? "";
  const priorityFilter = sp.priority ?? "";

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, name")
    .order("name");

  let q = supabase
    .from("punch_items")
    .select(
      "id, title, location, status, priority, due_date, created_at, assigned_to, jobs(name), assignee:profiles!assigned_to(full_name)"
    )
    .order("created_at", { ascending: false });
  if (jobFilter) q = q.eq("job_id", jobFilter);
  if (statusFilter) q = q.eq("status", statusFilter);
  if (priorityFilter) q = q.eq("priority", priorityFilter);
  const { data: rowsRaw } = await q;
  const rows = (rowsRaw ?? []) as unknown as Row[];

  const exportRows = rows.map((r) => ({
    title: r.title,
    job: r.jobs?.name ?? "",
    location: r.location ?? "",
    assignee: r.assignee?.full_name ?? "",
    status: r.status,
    priority: r.priority,
    due: r.due_date ? new Date(r.due_date).toLocaleDateString() : "",
  }));

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Punch List" subtitle="Closeout items & deficiencies" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <PunchFilters
          jobs={jobs ?? []}
          currentJob={jobFilter}
          currentStatus={statusFilter}
          currentPriority={priorityFilter}
        />
        {canCreate && (
          <Link
            href="/punch/new"
            className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Plus className="w-5 h-5" /> New Punch Item
          </Link>
        )}
        {rows.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center">
            <CheckSquare className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No punch items yet</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
              Track closeout items, deficiencies, and incomplete work.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/punch/${r.id}`}
                className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">{r.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {r.jobs?.name ?? ""}
                      {r.location ? ` · ${r.location}` : ""}
                      {r.assignee?.full_name ? ` · ${r.assignee.full_name}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusCls(r.status)}`}>
                      {r.status.replace("_", " ")}
                    </span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${priorityCls(r.priority)}`}>
                      {r.priority}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
        {rows.length > 0 && <PunchExportButton rows={exportRows} />}
      </main>
    </div>
  );
}