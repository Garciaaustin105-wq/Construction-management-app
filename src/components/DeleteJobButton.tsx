"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

export default function DeleteJobButton({
  jobId,
  jobName,
}: {
  jobId: string;
  jobName: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      // 1. Gather storage paths so we can clean up files
      const [photosRes, blueprintsRes] = await Promise.all([
        supabase.from("photos").select("storage_path").eq("job_id", jobId),
        supabase.from("blueprints").select("storage_path").eq("job_id", jobId),
      ]);

      const photoPaths = (photosRes.data ?? []).map((p) => p.storage_path);
      const blueprintPaths = (blueprintsRes.data ?? []).map(
        (b) => b.storage_path
      );

      // 2. Delete storage objects (best-effort; don't block DB cleanup on failure)
      if (photoPaths.length > 0) {
        await supabase.storage.from("job-photos").remove(photoPaths);
      }
      if (blueprintPaths.length > 0) {
        await supabase.storage.from("blueprints").remove(blueprintPaths);
      }

      // 3. Delete related rows. Order matters if there's no ON DELETE CASCADE.
      await supabase.from("photos").delete().eq("job_id", jobId);
      await supabase.from("blueprints").delete().eq("job_id", jobId);
      await supabase.from("rfis").delete().eq("job_id", jobId);
      await supabase.from("job_views").delete().eq("job_id", jobId);

      // 4. Delete the job itself
      const { error } = await supabase.from("jobs").delete().eq("id", jobId);
      if (error) {
        toast.error(`Failed to delete: ${error.message}`);
        setDeleting(false);
        setConfirming(false);
        return;
      }

      toast.success(`Deleted project "${jobName}"`);
      router.push("/dashboard");
    } catch {
      toast.error("Something went wrong deleting the project");
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="w-full text-red-600 bg-red-50 border border-red-200 py-3 rounded-lg text-sm font-semibold active:bg-red-100 flex items-center justify-center gap-2"
      >
        <Trash2 className="w-4 h-4" />
        Delete Project
      </button>
    );
  }

  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
      <p className="text-sm text-red-900 font-medium">
        Delete &ldquo;{jobName}&rdquo; permanently?
      </p>
      <p className="text-xs text-red-700">
        All photos, blueprints, RFIs, and activity will be removed. This can&rsquo;t be undone.
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="flex-1 py-2 rounded-lg bg-white border border-gray-300 text-sm font-medium text-gray-700 active:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold active:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {deleting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Deleting...
            </>
          ) : (
            <>
              <Trash2 className="w-4 h-4" />
              Delete
            </>
          )}
        </button>
      </div>
    </div>
  );
}