"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import BlueprintPreview from "./BlueprintPreview";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";

type Blueprint = {
  id: string;
  storage_path: string;
  filename: string;
  caption: string | null;
  created_at: string;
};

export default function CustomerBlueprints({
  blueprints,
}: {
  blueprints: Blueprint[];
}) {
  const supabase = createClient();
  const toast = useToast();
  const [preview, setPreview] = useState<Blueprint | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  if (blueprints.length === 0) return null;

  // Private bucket: mint a signed URL on demand (customer has a scoped
  // storage SELECT policy on the blueprints bucket).
  async function openPreview(b: Blueprint) {
    const { data } = await supabase.storage
      .from("blueprints")
      .createSignedUrl(b.storage_path, 3600);
    if (!data?.signedUrl) {
      toast.error("Could not load blueprint");
      return;
    }
    setPreview(b);
    setPreviewUrl(data.signedUrl);
  }

  return (
    <>
      <div className="border-t border-gray-100 p-3">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
          Blueprints ({blueprints.length})
        </p>
        <div className="space-y-1">
          {blueprints.map((b) => (
            <button
              key={b.id}
              onClick={() => openPreview(b)}
              className="block text-sm text-blue-600 underline truncate flex items-center gap-1 text-left w-full"
            >
              <FileText className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{b.filename}</span>
            </button>
          ))}
        </div>
      </div>
      {preview && previewUrl && (
        <BlueprintPreview
          url={previewUrl}
          filename={preview.filename}
          onClose={() => {
            setPreview(null);
            setPreviewUrl(null);
          }}
        />
      )}
    </>
  );
}