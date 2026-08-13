"use client";

import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { FileText, Upload, Trash2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { Spinner } from "@/components/Skeleton";
import BlueprintPreview from "@/components/BlueprintPreview";
import { validateUpload } from "@/lib/uploadValidate";

type Blueprint = {
  id: string;
  storage_path: string;
  filename: string;
  caption: string | null;
  created_at: string;
};

export default function BlueprintsSection({
  jobId,
  blueprints,
  role,
}: {
  jobId: string;
  blueprints: Blueprint[];
  role: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState("");
  const [preview, setPreview] = useState<Blueprint | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  // Blueprints are in a PRIVATE bucket, so the preview is served via a signed
  // URL minted on demand (the blueprints bucket RLS grants SELECT to office,
  // assigned crew, and the owning customer — same model as receipts).
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

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.warning("Pick a file first");
      return;
    }
    const v = validateUpload(file, "blueprint");
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setUploading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setUploading(false);
      return;
    }

    const path = `${jobId}/${crypto.randomUUID()}-${file.name}`;
    const { error: upError } = await supabase.storage
      .from("blueprints")
      .upload(path, file);
    if (upError) {
      toast.error(`Upload failed: ${upError.message}`);
      setUploading(false);
      return;
    }

    const { error: dbError } = await supabase.from("blueprints").insert({
      job_id: jobId,
      uploaded_by: user.id,
      storage_path: path,
      filename: file.name,
      caption: caption || null,
    });
    if (dbError) {
      toast.error(`Save failed: ${dbError.message}`);
    } else {
      toast.success("Blueprint uploaded");
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    }
    setUploading(false);
  }

  async function handleDelete(blueprint: Blueprint) {
    if (!confirm(`Delete ${blueprint.filename}?`)) return;
    await supabase.storage.from("blueprints").remove([blueprint.storage_path]);
    await supabase.from("blueprints").delete().eq("id", blueprint.id);
    toast.success("Blueprint deleted");
    router.refresh();
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-2">
        <FileText className="w-4 h-4" />
        Blueprints ({blueprints.length})
      </h2>

      {/* Office upload form */}
      {role === "office" && (
        <form
          onSubmit={handleUpload}
          className="bg-white rounded-lg p-3 shadow-sm space-y-2 mb-3"
        >
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/*"
            className="block w-full text-sm text-gray-900 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-semibold"
          />
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Optional caption (e.g. 'Floor 2 plan')"
            className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            type="submit"
            disabled={uploading}
            className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {uploading ? (
              <>
                <Spinner className="w-4 h-4" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                Upload Blueprint
              </>
            )}
          </button>
        </form>
      )}

      {/* List of blueprints */}
      <div className="bg-white rounded-lg shadow-sm divide-y">
        {blueprints.length === 0 && (
          <div className="py-6 flex flex-col items-center text-center">
            <div className="w-10 h-10 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-2">
              <FileText className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-gray-700">No blueprints yet</p>
            {role === "office" && (
              <p className="text-xs text-gray-500 mt-1 max-w-xs">
                Upload a PDF or image above to share floor plans, rack elevations, or wiring diagrams with the crew.
              </p>
            )}
          </div>
        )}
        {blueprints.map((b) => (
          <div key={b.id} className="p-3 flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <button
                onClick={() => openPreview(b)}
                className="text-sm font-medium text-blue-600 underline truncate block flex items-center gap-1 text-left w-full"
              >
                <FileText className="w-4 h-4 inline flex-shrink-0" />
                <span className="truncate">{b.filename}</span>
              </button>
              {b.caption && (
                <p className="text-xs text-gray-500 truncate">{b.caption}</p>
              )}
              <p className="text-xs text-gray-400">
                {new Date(b.created_at).toLocaleDateString()}
              </p>
            </div>
            {role === "office" && (
              <button
                onClick={() => handleDelete(b)}
                className="ml-2 text-red-600 p-2 rounded hover:bg-red-50"
                title="Delete blueprint"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
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
    </section>
  );
}