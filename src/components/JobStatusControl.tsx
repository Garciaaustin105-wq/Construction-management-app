"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Spinner } from "@/components/Skeleton";

const STATUSES = [
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "on_hold", label: "On Hold" },
  { value: "completed", label: "Completed" },
];

export default function JobStatusControl({
  jobId,
  currentStatus,
}: {
  jobId: string;
  currentStatus: string;
}) {
  const [status, setStatus] = useState(currentStatus);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  async function handleChange(newStatus: string) {
    setSaving(true);
    setStatus(newStatus);
    const { error } = await supabase
      .from("jobs")
      .update({ status: newStatus })
      .eq("id", jobId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      setStatus(currentStatus);
    } else {
      toast.success("Status updated");
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
        Job Status
        {saving && <Spinner className="w-4 h-4 text-blue-600" />}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        {STATUSES.map((s) => {
          const active = status === s.value;
          return (
            <button
              key={s.value}
              onClick={() => handleChange(s.value)}
              disabled={saving}
              className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                active
                  ? "bg-blue-50 border-blue-500 text-blue-700 ring-2 ring-blue-500"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              } disabled:opacity-50`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}