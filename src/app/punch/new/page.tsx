"use client";
import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import PageContainer from "@/components/PageContainer";
import FormGrid from "@/components/ui/FormGrid";
import Button from "@/components/ui/Button";
import { FIELD_MGMT } from "@/lib/roles";

function PunchForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();
  const [jobId, setJobId] = useState(preselectedJob);
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [priority, setPriority] = useState("normal");
  const [dueDate, setDueDate] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [crew, setCrew] = useState<{ id: string; full_name: string }[]>([]);

  useEffect(() => {
    (async () => {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/login"); return; }
      const { data: profile } = await supabase.from("profiles").select("role, organization_id").eq("id", user.id).single();
      if (!FIELD_MGMT.has((profile?.role ?? "crew") as never)) { router.push("/dashboard"); return; }
      setAuthorized(true);
      const [{ data: jobRows }, { data: crewList }] = await Promise.all([
        supabase.from("jobs").select("id, name, type").eq("type", "construction").order("created_at", { ascending: false }),
        supabase.from("profiles").select("id, full_name").in("role", ["crew", "superintendent"]).order("full_name"),
      ]);
      let jobsList = (jobRows ?? []) as { id: string; name: string; type: string }[];
      if (preselectedJob && !jobsList.some(x => x.id === preselectedJob)) {
        const { data: preJob } = await supabase.from("jobs").select("id, name, type").eq("id", preselectedJob).maybeSingle();
        if (preJob) jobsList = [preJob as { id: string; name: string; type: string }, ...jobsList];
      }
      setJobs(jobsList.map(j => ({ id: j.id, name: j.name })));
      setCrew(crewList ?? []);
    })();
  }, [router, preselectedJob]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId || !title) { toast.warning("Pick a job and enter a title"); return; }
    setLoading(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Not signed in"); setLoading(false); return; }
    const { data, error } = await supabase.from("punch_items").insert({
      job_id: jobId,
      title,
      description: description || null,
      location: location || null,
      assigned_to: assignedTo || null,
      priority,
      due_date: dueDate ? new Date(dueDate).toISOString() : null,
      status: "open",
      created_by: user.id,
    }).select().single();
    if (error || !data) { toast.error(`Failed: ${error?.message ?? "error"}`); setLoading(false); return; }
    if (photo) {
      const path = `${jobId}/${crypto.randomUUID()}.${photo.name.split('.').pop()}`;
      await supabase.storage.from("job-photos").upload(path, photo);
      await supabase.from("photos").insert({ job_id: jobId, storage_path: path, punch_item_id: data.id, uploaded_by: user.id });
    }
    toast.success("Punch item created");
    setTimeout(() => router.push(preselectedJob ? `/punch/${data.id}?job=${preselectedJob}` : `/punch/${data.id}`), 600);
  }

  if (!authorized) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>;
  return (
    <PageContainer
      title="New Punch Item"
      backHref={preselectedJob ? `/jobs/${preselectedJob}` : "/punch"}
      backLabel={preselectedJob ? "Back to job" : "Punch Item"}
      maxWidth="form"
    >
        <form onSubmit={handleSubmit}>
          <FormGrid columns={2}>
            <select value={jobId} onChange={e => setJobId(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base">
              <option value="">Select a job</option>
              {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} required className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Title" />
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base lg:col-span-2" placeholder="Description" />
            <input type="text" value={location} onChange={e => setLocation(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Location" />
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base">
              <option value="">Unassigned</option>
              {crew.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
            <select value={priority} onChange={e => setPriority(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
            <input type="file" accept="image/*" onChange={e => setPhoto(e.target.files?.[0] ?? null)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base lg:col-span-2" />
              <Button
                type="submit"
                disabled={loading}
                size="lg"
                block
                className="lg:col-span-2 py-4"
              >
                {loading && <Loader2 className="w-5 h-5 animate-spin" />}
                {loading ? "Creating..." : "Create Punch Item"}
              </Button>
          </FormGrid>
        </form>
    </PageContainer>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}><PunchForm /></Suspense>;
}