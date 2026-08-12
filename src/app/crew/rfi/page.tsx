"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { HelpCircle, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

function RfiForm() {
  const search = useSearchParams();
  const router = useRouter();
  const preselectedJob = search.get("job") ?? "";

  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const supabase = createClient();
  const toast = useToast();

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (profile?.role !== "office") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);
      const { data } = await supabase
        .from("jobs")
        .select("id, name");
      setJobs(data ?? []);
    })();
  }, [router, supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId || !question.trim()) {
      toast.warning("Pick a job and write a question");
      return;
    }
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }

    const { error } = await supabase.from("rfis").insert({
      job_id: jobId,
      submitted_by: user.id,
      question,
    });
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("RFI submitted");
      setQuestion("");
    }
    setLoading(false);
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Submit RFI" />
      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Job</span>
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            >
              <option value="">Select job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Question</span>
            <textarea
              placeholder="What do you need clarified?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              required
              rows={6}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-amber-600 text-white py-4 rounded-lg font-semibold text-base active:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <HelpCircle className="w-5 h-5" />
            )}
            {loading ? "Submitting..." : "Submit RFI"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function RfiPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}>
      <RfiForm />
    </Suspense>
  );
}