"use client";
import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import PageContainer from "@/components/PageContainer";
import FormGrid from "@/components/ui/FormGrid";
import Button from "@/components/ui/Button";

function SubmittalForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();
  const [jobId, setJobId] = useState(preselectedJob);
  const [jobs, setJobs] = useState<{id:string;name:string}[]>([]);
  const [costCodes, setCostCodes] = useState<{id:string;code:string;name:string}[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [csiSection, setCsiSection] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => { (async () => {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/login"); return; }
    const { data: profile } = await supabase.from("profiles").select("role, organization_id").eq("id", user.id).single();
    if (profile?.role !== "office" && profile?.role !== "admin" && profile?.role !== "project_manager") { router.push("/dashboard"); return; }
    setAuthorized(true);
    const [{ data: jobRows }, { data: costCodesRows }] = await Promise.all([
      supabase.from("jobs").select("id, name, type").eq("type","construction").order("created_at",{ascending:false}),
      supabase.from("cost_codes").select("id, code, name").order("code"),
    ]);
    let jobsList = (jobRows ?? []) as {id:string;name:string;type:string}[];
    if (preselectedJob && !jobsList.some(x => x.id === preselectedJob)) {
      const { data: preJob } = await supabase.from("jobs").select("id, name, type").eq("id", preselectedJob).maybeSingle();
      if (preJob) jobsList = [preJob as { id: string; name: string; type: string }, ...jobsList];
    }
    setJobs(jobsList.map(j => ({id:j.id, name:j.name})));
    setCostCodes(costCodesRows ?? []);
  })(); }, [router, preselectedJob]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId || !title) { toast.warning("Pick a job and enter a title"); return; }
    setLoading(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Not signed in"); setLoading(false); return; }
    const { data: existingSubmittals } = await supabase.from("submittals").select("submittal_number").order("submittal_number", { ascending: false }).limit(1);
    const lastNumber = existingSubmittals?.[0]?.submittal_number ?? "SUB-0000";
    const lastNum = parseInt(lastNumber.match(/(\d+)$/)?.[0] ?? "0", 10);
    const newNumber = `SUB-${(lastNum + 1).toString().padStart(4, "0")}`;
    const { data, error } = await supabase.from("submittals").insert({
      job_id: jobId, submittal_number: newNumber, title, description: description || null, csi_section: csiSection || null,
      cost_code_id: costCodeId || null, status: "draft", ball_in_court: "office", created_by: user.id
    }).select().single();
    if (error || !data) { toast.error(`Failed: ${error?.message ?? "error"}`); setLoading(false); return; }
    for (const file of files) {
      const path = `${jobId}/${data.id}/${crypto.randomUUID()}-${file.name}`;
      await supabase.storage.from("submittal-files").upload(path, file);
      await supabase.from("submittal_files").insert({
        job_id: jobId, submittal_id: data.id, filename: file.name, storage_path: path, uploaded_by: user.id
      });
    }
    toast.success("Submittal created");
    setTimeout(() => router.push(preselectedJob ? `/submittals/${data.id}?job=${preselectedJob}` : `/submittals/${data.id}`), 600);
  }
  if (!authorized) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>;
  return (
    <PageContainer
      title="New Submittal"
      backHref={preselectedJob ? `/jobs/${preselectedJob}` : "/submittals"}
      backLabel={preselectedJob ? "Back to job" : "Submittals"}
      maxWidth="form"
    >
        <form onSubmit={handleSubmit}>
          <FormGrid columns={2}>
            <select value={jobId} onChange={e => setJobId(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base">
              <option value="">Select a job</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} required className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Title" />
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base lg:col-span-2" placeholder="Description" />
            <input type="text" value={csiSection} onChange={e => setCsiSection(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="CSI Section (e.g. 09 30 00)" />
            <select value={costCodeId} onChange={e => setCostCodeId(e.target.value)} className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base">
              <option value="">None</option>{costCodes.map(c => <option key={c.id} value={c.id}>{c.code} - {c.name}</option>)}
            </select>
            <input type="file" accept=".pdf,image/*" multiple onChange={e => setFiles(Array.from(e.target.files ?? []))} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base lg:col-span-2" />
              <Button
                type="submit"
                disabled={loading}
                size="lg"
                block
                className="lg:col-span-2 py-4"
              >
                {loading && <Loader2 className="w-5 h-5 animate-spin" />}
                {loading ? "Saving..." : "Save Draft"}
              </Button>
          </FormGrid>
        </form>
    </PageContainer>
  );
}
export default function Page() {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}><SubmittalForm /></Suspense>;
}