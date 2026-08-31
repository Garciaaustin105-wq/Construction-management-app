"use client";

// Safe job delete. The previous version removed photo/blueprint FILES from
// storage FIRST, then ran supabase.from("jobs").delete() — which cascades
// across 21 tables (invoices, receipts, chemical_applications …) behind an
// office RLS policy. A failed delete still lost the files permanently, and one
// click on a live customer's job destroyed an invoice, an estimate and legal
// pesticide records with no way back.
//
// The ONLY delete path now is the delete_job_if_empty RPC: it refuses any job
// with history, reports what's blocking as blocked_by counts, and never
// touches storage. Files are removed only AFTER the RPC reports deleted: true.
// A blocked delete is not an error — it names what's in the way and offers
// Archive (jobs.archived_at; visibility, not lifecycle).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Trash2, Loader2, Archive } from "lucide-react";
import { useToast } from "@/components/Toast";

const BLOCKER_LABEL: Record<string, string> = {
  invoices: "invoice",
  estimates: "estimate",
  proposals: "proposal",
  photos: "photo",
  blueprints: "blueprint",
  rfis: "RFI",
  receipts: "receipt",
  time_entries: "time entry",
  chemical_applications: "pesticide record",
  lawn_visits: "lawn visit",
  recurring_schedules: "recurring schedule",
  change_orders: "change order",
  punch_items: "punch item",
  daily_logs: "daily log",
  submittals: "submittal",
  schedule_events: "scheduled event",
  job_subcontractors: "subcontractor assignment",
};

// "1 invoice, 5 photos and 2 time entries" — names what's in the way in the
// order that matters (largest first). Exported so the lawn jobs list can say
// exactly the same words.
export function formatBlockedBy(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const label = BLOCKER_LABEL[key] ?? key.replace(/_/g, " ");
      return `${n} ${n === 1 ? label : `${label}s`}`;
    });
  if (parts.length === 0) return "records attached to it";
  return parts.join(", ").replace(/, ([^,]*)$/, " and $1");
}

type DeleteJobResult = {
  deleted: boolean;
  total: number;
  blocked_by?: Record<string, number>;
};

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
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<Record<string, number> | null>(null);

  // Reads the storage paths up front (harmless — reading doesn't destroy
  // anything) so cleanup can happen AFTER the RPC reports deleted: true. Once
  // the job row is gone the photo/blueprint rows cascade with it, so the
  // paths must be known before the delete.
  async function gatherStoragePaths(): Promise<{
    photoPaths: string[];
    blueprintPaths: string[];
  }> {
    const [photosRes, blueprintsRes] = await Promise.all([
      supabase.from("photos").select("storage_path").eq("job_id", jobId),
      supabase.from("blueprints").select("storage_path").eq("job_id", jobId),
    ]);
    return {
      photoPaths: (photosRes.data ?? []).map((p) => p.storage_path),
      blueprintPaths: (blueprintsRes.data ?? []).map((b) => b.storage_path),
    };
  }

  async function handleDelete() {
    setBusy(true);
    setBlocked(null);
    try {
      const { photoPaths, blueprintPaths } = await gatherStoragePaths();

      const { data, error } = await supabase.rpc("delete_job_if_empty", {
        p_job_id: jobId,
      });
      if (error) {
        toast.error(`Failed to delete: ${error.message}`);
        return;
      }
      const result = data as DeleteJobResult | null;
      if (!result?.deleted) {
        // Not an error — a refusal with reasons. Name the blockers and offer
        // Archive as the action.
        setBlocked(result?.blocked_by ?? {});
        return;
      }

      // Only now are the files orphaned by design — remove them (best-effort;
      // a storage hiccup must not mask the successful delete).
      if (photoPaths.length > 0) {
        await supabase.storage.from("job-photos").remove(photoPaths);
      }
      if (blueprintPaths.length > 0) {
        await supabase.storage.from("blueprints").remove(blueprintPaths);
      }
      toast.success(`Deleted project "${jobName}"`);
      router.push("/dashboard");
    } catch {
      toast.error("Something went wrong deleting the project");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    setBusy(true);
    try {
      const { error } = await supabase
        .from("jobs")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", jobId);
      if (error) {
        toast.error(`Failed to archive: ${error.message}`);
        return;
      }
      toast.success(`Archived "${jobName}"`);
      router.push("/dashboard");
    } finally {
      setBusy(false);
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

  if (blocked) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
        <p className="text-sm text-amber-900 font-medium">
          This project can&rsquo;t be deleted — nothing was removed.
        </p>
        <p className="text-xs text-amber-800">
          It has {formatBlockedBy(blocked)}. History like this is kept, not
          deleted — especially anything that gets billed or has legal retention
          (pesticide records). Archive instead: it hides the project from
          active lists while keeping every record and file.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setBlocked(null);
              setConfirming(false);
            }}
            disabled={busy}
            className="flex-1 py-2 rounded-lg bg-white border border-gray-300 text-sm font-medium text-gray-700 active:bg-gray-50 disabled:opacity-50"
          >
            Back
          </button>
          <button
            onClick={handleArchive}
            disabled={busy}
            className="flex-1 py-2 rounded-lg bg-gray-900 text-white text-sm font-semibold active:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Archive className="w-4 h-4" />
            )}
            Archive instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
      <p className="text-sm text-red-900 font-medium">
        Delete &ldquo;{jobName}&rdquo; permanently?
      </p>
      <p className="text-xs text-red-700">
        Only projects with no history can be deleted. If this one has invoices,
        photos or records, we&rsquo;ll tell you what&rsquo;s in the way and
        suggest archiving it instead. Nothing is removed until the final
        confirmation.
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="flex-1 py-2 rounded-lg bg-white border border-gray-300 text-sm font-medium text-gray-700 active:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleDelete}
          disabled={busy}
          className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold active:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking...
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