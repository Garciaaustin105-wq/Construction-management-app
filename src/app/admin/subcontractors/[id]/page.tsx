import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect, notFound } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import SubcontractorDetail, {
  type SubDetail,
  type SubAttachment,
  type AttachedJob,
} from "@/components/SubcontractorDetail";
import { MANAGEMENT, type Role } from "@/lib/roles";

export default async function SubcontractorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role as Role;
  if (!MANAGEMENT.has(role)) redirect("/dashboard");

  const [{ data: sub }, { data: atts }, { data: linked }, { data: allJobs }] = await Promise.all([
    supabase
      .from("subcontractors")
      .select("id, company, contact_name, trade, phone, email, notes")
      .eq("id", id)
      .single(),
    supabase
      .from("subcontractor_attachments")
      .select("id, filename, storage_path, created_at")
      .eq("subcontractor_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("job_subcontractors")
      .select("job_id, role_on_job, job:jobs(name)")
      .eq("subcontractor_id", id),
    supabase.from("jobs").select("id, name").eq("type", "construction").order("name"),
  ]);

  if (!sub) notFound();

  const attachedJobs: AttachedJob[] = (linked ?? []).map((row) => {
    const r = row as unknown as {
      job_id: string;
      role_on_job: string | null;
      job: { name: string | null } | null;
    };
    return {
      job_id: r.job_id,
      job_name: r.job?.name ?? "—",
      role_on_job: r.role_on_job,
    };
  });

  return (
    <PageContainer title="Subcontractor" maxWidth="list" backHref="/admin/subcontractors" backLabel="Subcontractors">
      <SubcontractorDetail
        sub={sub as unknown as SubDetail}
        attachments={(atts as SubAttachment[]) ?? []}
        attachedJobs={attachedJobs}
        allJobs={(allJobs as { id: string; name: string }[]) ?? []}
        canEdit={role === "office" || role === "admin" || role === "project_manager"}
      />
    </PageContainer>
  );
}