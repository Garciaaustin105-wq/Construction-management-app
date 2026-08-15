"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Plus, X, Loader2, Briefcase, Phone, Mail } from "lucide-react";

export type JobSub = {
  subcontractor_id: string;
  company: string;
  trade: string | null;
  phone: string | null;
  email: string | null;
  role_on_job: string | null;
  scheduled_date: string | null;
};

export default function JobSubcontractors({
  jobId,
  initial,
  allSubs,
  canEdit = false,
}: {
  jobId: string;
  initial: JobSub[];
  allSubs: { id: string; company: string }[];
  canEdit?: boolean;
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();

  const [subs, setSubs] = useState<JobSub[]>(initial);
  const [pickSub, setPickSub] = useState("");
  const [pickRole, setPickRole] = useState("");
  const [pickDate, setPickDate] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Subs not yet attached (for the picker).
  const attachedIds = new Set(subs.map((s) => s.subcontractor_id));
  const available = allSubs.filter((s) => !attachedIds.has(s.id));

  async function attach(e: React.FormEvent) {
    e.preventDefault();
    if (!pickSub) {
      toast.warning("Pick a subcontractor");
      return;
    }
    setAttaching(true);
    const { error } = await supabase.from("job_subcontractors").insert({
      job_id: jobId,
      subcontractor_id: pickSub,
      role_on_job: pickRole.trim() || null,
      scheduled_date: pickDate || null,
    });
    setAttaching(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    const company = allSubs.find((s) => s.id === pickSub)?.company ?? "—";
    setSubs((prev) => [
      ...prev,
      {
        subcontractor_id: pickSub,
        company,
        trade: null,
        phone: null,
        email: null,
        role_on_job: pickRole.trim() || null,
        scheduled_date: pickDate || null,
      },
    ]);
    setPickSub("");
    setPickRole("");
    setPickDate("");
    toast.success("Subcontractor attached");
    router.refresh();
  }

  // Update the scheduled on-site date for an attached sub (office only).
  async function setScheduledDate(subId: string, value: string) {
    setBusyId(subId);
    const { error } = await supabase
      .from("job_subcontractors")
      .update({ scheduled_date: value || null })
      .eq("job_id", jobId)
      .eq("subcontractor_id", subId);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setSubs((prev) =>
      prev.map((s) =>
        s.subcontractor_id === subId ? { ...s, scheduled_date: value || null } : s
      )
    );
    toast.success("On-site date saved");
  }

  async function detach(subId: string) {
    if (!confirm("Remove this subcontractor from the job?")) return;
    setBusyId(subId);
    const { error } = await supabase
      .from("job_subcontractors")
      .delete()
      .eq("job_id", jobId)
      .eq("subcontractor_id", subId);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setSubs((prev) => prev.filter((s) => s.subcontractor_id !== subId));
    toast.success("Removed");
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
        Subcontractors ({subs.length})
      </h2>

      {canEdit && (
        <form
          onSubmit={attach}
          className="bg-white rounded-lg p-3 shadow-sm space-y-2 mb-2"
        >
          <div className="flex items-center gap-1 text-sm font-medium text-gray-700">
            <Plus className="w-4 h-4" /> Attach subcontractor
          </div>
          {available.length > 0 ? (
            <>
              <select
                value={pickSub}
                onChange={(e) => setPickSub(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
              >
                <option value="">Select subcontractor…</option>
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.company}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Role on this job (optional)"
                value={pickRole}
                onChange={(e) => setPickRole(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
              <label className="block">
                <span className="text-xs text-gray-500">On-site date (optional)</span>
                <input
                  type="date"
                  value={pickDate}
                  onChange={(e) => setPickDate(e.target.value)}
                  className="mt-0.5 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <button
                type="submit"
                disabled={attaching}
                className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {attaching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Attach
              </button>
            </>
          ) : (
            <p className="text-xs text-gray-500">
              All subcontractors are already attached
              {allSubs.length === 0 && " — add some in the Subcontractors page first."}.
            </p>
          )}
        </form>
      )}

      {subs.length === 0 ? (
        <div className="bg-white rounded-lg py-6 text-center shadow-sm">
          <Briefcase className="w-6 h-6 text-gray-300 mx-auto mb-1" />
          <p className="text-sm text-gray-500">No subcontractors on this job.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
          {subs.map((s) => (
            <div key={s.subcontractor_id} className="p-3 space-y-2">
              <div className="flex items-start gap-2">
                <Link
                  href={`/admin/subcontractors/${s.subcontractor_id}`}
                  className="min-w-0 flex-1"
                >
                  <p className="font-medium text-gray-900 truncate flex items-center gap-1">
                    <Briefcase className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    {s.company}
                  </p>
                  {s.trade && (
                    <p className="text-xs text-blue-600 truncate">{s.trade}</p>
                  )}
                  {s.role_on_job && (
                    <p className="text-xs text-gray-500 truncate">{s.role_on_job}</p>
                  )}
                  <div className="flex flex-col gap-0.5 mt-1">
                    {s.phone && (
                      <span className="text-xs text-gray-600 inline-flex items-center gap-1">
                        <Phone className="w-3 h-3" /> {s.phone}
                      </span>
                    )}
                    {s.email && (
                      <span className="text-xs text-gray-600 inline-flex items-center gap-1 truncate">
                        <Mail className="w-3 h-3" /> {s.email}
                      </span>
                    )}
                  </div>
                </Link>
                {canEdit && (
                  <button
                    onClick={() => detach(s.subcontractor_id)}
                    disabled={busyId === s.subcontractor_id}
                    className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
                    title="Remove"
                  >
                    {busyId === s.subcontractor_id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <X className="w-4 h-4" />
                    )}
                  </button>
                )}
              </div>
              {/* On-site date — editable for office, read for other management. */}
              {canEdit ? (
                <label className="block">
                  <span className="text-xs text-gray-500">On-site date</span>
                  <input
                    type="date"
                    value={s.scheduled_date ?? ""}
                    onChange={(e) =>
                      setScheduledDate(s.subcontractor_id, e.target.value)
                    }
                    disabled={busyId === s.subcontractor_id}
                    className="mt-0.5 w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                  />
                </label>
              ) : (
                s.scheduled_date && (
                  <p className="text-xs text-gray-600">
                    On-site: {new Date(s.scheduled_date + "T00:00:00").toLocaleDateString()}
                  </p>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}