"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Pencil, Save, X } from "lucide-react";
import { Spinner } from "@/components/Skeleton";

export default function JobAssignmentEditor({
  jobId,
  initialCustomerId,
  initialCrew,
  canEdit,
  onSaved,
}: {
  jobId: string;
  initialCustomerId: string | null;
  initialCrew: string[];
  canEdit: boolean;
  onSaved?: (customerId: string | null, crew: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customerId, setCustomerId] = useState(initialCustomerId ?? "");
  const [assigned, setAssigned] = useState(initialCrew);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [crew, setCrew] = useState<{ id: string; name: string; user_id: string | null }[]>([]);

  const toast = useToast();

  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      supabase.from("customers").select("id, name").order("name"),
      supabase.from("crew_members").select("id, name, user_id").order("name"),
    ]).then(([customersRes, crewRes]) => {
      if (!customersRes.error) {
        setCustomers(customersRes.data);
      }
      if (!crewRes.error) {
        setCrew(crewRes.data);
      }
    });
  }, []);

  function toggleCrew(id: string) {
    setAssigned((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function save() {
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("jobs")
      .update({
        customer_id: customerId || null,
        assigned_crew: assigned,
      })
      .eq("id", jobId);
    setSaving(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Assignment updated");
      setEditing(false);
      onSaved?.(customerId || null, assigned);
    }
  }

  return (
    <div>
      {editing ? (
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-semibold text-gray-700">Edit assignment</h2>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-gray-500 font-medium flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          </div>
          <div>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Customer</span>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                <option value="">Select customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <span className="text-sm font-medium text-gray-700">Crew</span>
            <div className="mt-2 space-y-2">
              {crew.map((c) => (
                <label key={c.id} className="flex items-center gap-3 p-3 rounded-lg border border-gray-200">
                  <input
                    type="checkbox"
                    checked={assigned.includes(c.id)}
                    onChange={() => toggleCrew(c.id)}
                    className="w-5 h-5"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{c.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {c.user_id ? "App user" : "Scheduling only - no app login"}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full bg-green-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {saving ? (
              <>
                <Spinner className="w-4 h-4" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save
              </>
            )}
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-2">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-semibold text-gray-700">Assignment</h2>
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-blue-600 font-medium flex items-center gap-1"
              >
                <Pencil className="w-3.5 h-3.5" />
                Edit
              </button>
            )}
          </div>
          <dl className="space-y-1.5 text-sm">
            <div>
              <dt className="text-gray-500">Customer</dt>
              <dd className="text-gray-900 font-medium">
                {customerId
                  ? customers.find((c) => c.id === customerId)?.name || "-"
                  : "-"}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Crew</dt>
              <dd className="text-gray-900 font-medium">
                {assigned.length > 0
                  ? assigned
                      .map((id) => crew.find((c) => c.id === id)?.name)
                      .filter((name) => name)
                      .join(", ")
                  : "Unassigned"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}