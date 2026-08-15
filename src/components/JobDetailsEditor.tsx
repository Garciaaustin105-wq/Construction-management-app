"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Spinner } from "@/components/Skeleton";
import MapLink from "@/components/MapLink";
import { Pencil, X } from "lucide-react";

export default function JobDetailsEditor({
  jobId,
  initialName,
  initialAddress,
  initialDescription,
  canEdit,
  onSaved,
}: {
  jobId: string;
  initialName: string;
  initialAddress: string | null;
  initialDescription: string | null;
  canEdit: boolean;
  // Optional callback fired after a successful save, carrying the normalized
  // saved values. The construction job page is a server component and relies on
  // router.refresh() to re-fetch fresh props, so it doesn't need this. The Lawn
  // schedule page is a client component whose data is fetched in a useEffect —
  // router.refresh() won't re-trigger it — so it passes onSaved to update its
  // own state and re-render with the new address/description.
  onSaved?: (
    name: string,
    address: string | null,
    description: string | null
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [saving, setSaving] = useState(false);

  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("jobs")
      .update({
        name: name.trim() || initialName,
        address: address.trim() || null,
        description: description.trim() || null,
      })
      .eq("id", jobId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Job details updated");
      // Normalize local state to the saved values so a re-edit doesn't show
      // the untrimmed draft, then notify the parent (Lawn client page) so its
      // read-only view + TopBar reflect the change without a server refetch.
      const savedName = name.trim() || initialName;
      const savedAddress = address.trim() || null;
      const savedDescription = description.trim() || null;
      setName(savedName);
      setAddress(savedAddress ?? "");
      setDescription(savedDescription ?? "");
      setEditing(false);
      onSaved?.(savedName, savedAddress, savedDescription);
      router.refresh();
    }
    setSaving(false);
  }

  function cancel() {
    setName(initialName);
    setAddress(initialAddress ?? "");
    setDescription(initialDescription ?? "");
    setEditing(false);
  }

  return (
    <div>
      {editing ? (
        <div className="space-y-3 pt-1">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            Edit Details
            {saving && <Spinner className="w-4 h-4 text-blue-600" />}
          </h2>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Job name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Location / address
            </label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="123 Main St, Austin, TX"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {saving && <Spinner className="w-4 h-4 text-white" />}
              Save
            </button>
            <button
              onClick={cancel}
              disabled={saving}
              className="px-4 bg-gray-100 text-gray-700 py-2.5 rounded-lg font-semibold disabled:opacity-50 flex items-center gap-1"
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          {initialAddress && <MapLink address={initialAddress} />}
          {initialDescription && (
            <p className="text-sm text-gray-600 mt-2">{initialDescription}</p>
          )}
          {canEdit && (
            <button
              onClick={() => setEditing(true)}
              className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600 font-medium"
            >
              <Pencil className="w-4 h-4" />
              Edit details
            </button>
          )}
        </div>
      )}
    </div>
  );
}