"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { Camera, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

function PhotoUploadForm() {
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";

  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);
  const supabase = createClient();
  const toast = useToast();

  useEffect(() => {
    supabase
      .from("jobs")
      .select("id, name")
      .then(({ data }) => setJobs(data ?? []));
  }, []);

  useEffect(() => {
    if (preselectedJob && !jobId) setJobId(preselectedJob);
  }, [preselectedJob, jobId]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !jobId) {
      toast.warning("Pick a job and a file");
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

    const ext = file.name.split(".").pop();
    const path = `${jobId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("job-photos")
      .upload(path, file);
    if (uploadError) {
      toast.error(`Upload failed: ${uploadError.message}`);
      setLoading(false);
      return;
    }

    const { error: dbError } = await supabase.from("photos").insert({
      job_id: jobId,
      uploaded_by: user.id,
      storage_path: path,
      caption: caption || null,
    });
    if (dbError) {
      toast.error(`Save failed: ${dbError.message}`);
    } else {
      toast.success("Photo uploaded");
      setFile(null);
      setCaption("");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Upload Photo" />
      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleUpload} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
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
            <span className="text-sm font-medium text-gray-700">Photo</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
              className="mt-1 block w-full text-sm text-gray-900 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-semibold"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Caption (optional)</span>
            <textarea
              placeholder="What's in the photo?"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Camera className="w-5 h-5" />
            )}
            {loading ? "Uploading..." : "Upload Photo"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function PhotoUploadPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}>
      <PhotoUploadForm />
    </Suspense>
  );
}