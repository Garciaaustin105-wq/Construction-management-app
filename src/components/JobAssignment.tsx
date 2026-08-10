"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { UserCheck } from "lucide-react";
import { useToast } from "@/components/Toast";

type Crew = { id: string; full_name: string | null; email: string };

export default function JobAssignment({
  jobId,
  initialAssigned,
  crewMembers,
}: {
  jobId: string;
  initialAssigned: string[];
  crewMembers: Crew[];
}) {
  const [assigned, setAssigned] = useState<string[]>(initialAssigned);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  function toggle(userId: string) {
    setAssigned((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  }

  async function handleSave() {
    setSaving(true);
    const { error } = await supabase
      .from("jobs")
      .update({ assigned_crew: assigned })
      .eq("id", jobId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Assignment saved");
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <UserCheck className="w-5 h-5" />
        Assigned Crew
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Check the crew members working this job, then save.
      </p>
      <div className="space-y-2">
        {crewMembers.map((c) => (
          <label
            key={c.id}
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 active:bg-gray-50"
          >
            <input
              type="checkbox"
              checked={assigned.includes(c.id)}
              onChange={() => toggle(c.id)}
              className="w-5 h-5"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">
                {c.full_name ?? c.email}
              </p>
              <p className="text-xs text-gray-500 truncate">{c.email}</p>
            </div>
          </label>
        ))}
        {crewMembers.length === 0 && (
          <p className="text-sm text-amber-700 bg-amber-50 p-3 rounded">
            No crew members found. Add crew users in Supabase → Authentication → Users
            and set their role to &ldquo;crew&rdquo; in the profiles table.
          </p>
        )}
      </div>
      <button
        onClick={handleSave}
        disabled={saving || crewMembers.length === 0}
        className="mt-4 w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Assignment"}
      </button>
    </section>
  );
}