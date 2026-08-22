"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { createClient } from "@/lib/supabase/client";

export default function DailyLogPage() {
  const router = useRouter();
  const toast = useToast();
  const [jobId, setJobId] = useState("");
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [logDate, setLogDate] = useState(new Date().toISOString().split("T")[0]);
  const [weather, setWeather] = useState("");
  const [workPerformed, setWorkPerformed] = useState("");
  const [equipment, setEquipment] = useState("");
  const [materials, setMaterials] = useState("");
  const [delays, setDelays] = useState("");
  const [safetyNotes, setSafetyNotes] = useState("");
  const [crewCount, setCrewCount] = useState(0);
  const [photo, setPhoto] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      if (profile?.role === "customer") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);
      const { data: jobRows } = await supabase.from("jobs").select("id, name, type").eq("type", "construction").order("created_at", { ascending: false });
      setJobs(jobRows ?? []);
    })();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId) {
      toast.warning("Pick a job");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }
    const { data, error } = await supabase.from("daily_logs").insert({
      job_id: jobId,
      log_date: logDate,
      weather,
      work_performed: workPerformed,
      equipment,
      materials,
      delays,
      safety_notes: safetyNotes,
      crew_count: crewCount,
      status: "submitted",
      created_by: user.id,
    }).select().single();
    if (error) {
      if (error.code === "23505") {
        toast.error("A log already exists for this job on that date");
      } else {
        toast.error(`Failed: ${error.message}`);
      }
      setLoading(false);
      return;
    }
    if (photo) {
      const path = `${jobId}/${crypto.randomUUID()}.${photo.name.split(".").pop()}`;
      await supabase.storage.from("job-photos").upload(path, photo);
      await supabase.from("photos").insert({
        job_id: jobId,
        storage_path: path,
        daily_log_id: data.id,
        uploaded_by: user.id,
      });
    }
    toast.success("Daily log saved");
    setLogDate(new Date().toISOString().split("T")[0]);
    setWeather("");
    setWorkPerformed("");
    setEquipment("");
    setMaterials("");
    setDelays("");
    setSafetyNotes("");
    setCrewCount(0);
    setPhoto(null);
    setLoading(false);
  }

  if (!authorized) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button onClick={() => router.push("/field")} className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]">
          <ArrowLeft className="w-4 h-4 flex-shrink-0" /><span className="truncate">Back to field</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">Daily Log</h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Job</span>
            <select value={jobId} onChange={e => setJobId(e.target.value)} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
              <option value="">Select a job</option>
              {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Log Date</span>
            <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)} className="mt-0.5 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Weather</span>
            <input type="text" value={weather} onChange={e => setWeather(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Work Performed</span>
            <textarea value={workPerformed} onChange={e => setWorkPerformed(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Equipment</span>
            <input type="text" value={equipment} onChange={e => setEquipment(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Materials</span>
            <input type="text" value={materials} onChange={e => setMaterials(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Delays</span>
            <input type="text" value={delays} onChange={e => setDelays(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Safety Notes</span>
            <textarea value={safetyNotes} onChange={e => setSafetyNotes(e.target.value)} rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Crew Count</span>
            <NumberInput value={crewCount} onChange={setCrewCount} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">Photo</span>
            <input type="file" accept="image/*" onChange={e => setPhoto(e.target.files?.[0] ?? null)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          </label>
          <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}{loading ? "Saving..." : "Save"}
          </button>
        </form>
      </main>
    </div>
  );
}