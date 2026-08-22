"use client";
import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";

function DailyLogForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();
  const [jobId, setJobId] = useState(preselectedJob);
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0]);
  const [weather, setWeather] = useState("");
  const [workPerformed, setWorkPerformed] = useState("");
  const [equipment, setEquipment] = useState("");
  const [materials, setMaterials] = useState("");
  const [delays, setDelays] = useState("");
  const [safetyNotes, setSafetyNotes] = useState("");
  const [crewCount, setCrewCount] = useState(0);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => { (async () => {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/login"); return; }
    const { data: profile } = await supabase.from("profiles").select("role, organization_id").eq("id", user.id).single();
    if (profile?.role !== "office" && profile?.role !== "admin") { router.push("/dashboard"); return; }
    setAuthorized(true);
    const { data: jobRows } = await supabase.from("jobs").select("id, name, type").eq("type", "construction").order("created_at", { ascending: false });
    let jobsList = (jobRows ?? []) as { id: string; name: string; type: string }[];
    if (preselectedJob && !jobsList.some(x => x.id === preselectedJob)) {
      const { data: preJob } = await supabase.from("jobs").select("id, name, type").eq("id", preselectedJob).maybeSingle();
      if (preJob) jobsList = [preJob as { id: string; name: string; type: string }, ...jobsList];
    }
    setJobs(jobsList.map(j => ({ id: j.id, name: j.name })));
  })(); }, [router, preselectedJob]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId) { toast.warning("Pick a job"); return; }
    if (!logDate) { toast.warning("Pick a log date"); return; }
    setLoading(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Not signed in"); setLoading(false); return; }
    const { data, error } = await supabase.from("daily_logs").insert({
      job_id: jobId, log_date: logDate, weather: weather || null, work_performed: workPerformed, equipment: equipment, materials: materials, delays: delays, safety_notes: safetyNotes, crew_count: crewCount, status: "submitted", created_by: user.id,
    }).select().single();
    if (error) {
      if (error.code === "23505") {
        toast.error("A log already exists for this job on that date");
      } else {
        toast.error(`Failed: ${error?.message ?? "error"}`);
      }
      setLoading(false);
      return;
    }
    if (photoFile) {
      const ext = photoFile.name.split('.').pop() || "jpg";
      const path = `${jobId}/${crypto.randomUUID()}.${ext}`;
      await supabase.storage.from("job-photos").upload(path, photoFile);
      await supabase.from("photos").insert({ job_id: jobId, storage_path: path, daily_log_id: data.id, uploaded_by: user.id });
    }
    toast.success("Daily log saved");
    setTimeout(() => router.push(preselectedJob ? `/daily-logs/${data.id}?job=${preselectedJob}` : `/daily-logs/${data.id}`), 600);
  }

  if (!authorized) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>;
  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button onClick={() => router.push(preselectedJob ? `/jobs/${preselectedJob}` : "/daily-logs")} className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]">
          <ArrowLeft className="w-4 h-4 flex-shrink-0" /><span className="truncate">{preselectedJob ? "Back to job" : "Daily Logs"}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">New Daily Log</h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <select value={jobId} onChange={e => setJobId(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" disabled={!!preselectedJob}>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          <textarea value={weather} onChange={e => setWeather(e.target.value)} rows={1} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Weather conditions" />
          <textarea value={workPerformed} onChange={e => setWorkPerformed(e.target.value)} rows={3} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Work performed" />
          <textarea value={equipment} onChange={e => setEquipment(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Equipment used" />
          <textarea value={materials} onChange={e => setMaterials(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Materials used" />
          <textarea value={delays} onChange={e => setDelays(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Delays encountered" />
          <textarea value={safetyNotes} onChange={e => setSafetyNotes(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Safety notes" />
          <NumberInput value={crewCount} onChange={setCrewCount} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" placeholder="Crew count" />
          <input type="file" accept="image/*" onChange={e => setPhotoFile(e.target.files?.[0] || null)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}{loading ? "Saving..." : "Save Daily Log"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}><DailyLogForm /></Suspense>;
}