"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useToast } from "@/components/Toast";

export default function DeletePhotoButton({
  photoId,
  storagePath,
}: {
  photoId: string;
  storagePath: string;
}) {
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  async function handleDelete() {
    if (!customConfirm("Delete this photo? This can't be undone.")) return;
    setDeleting(true);
    await supabase.storage.from("job-photos").remove([storagePath]);
    const { error } = await supabase.from("photos").delete().eq("id", photoId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Photo deleted");
      router.refresh();
    }
    setDeleting(false);
  }

  return (
    <button
      onClick={handleDelete}
      disabled={deleting}
      className="absolute top-1 right-1 bg-red-600 text-white w-7 h-7 rounded-full shadow disabled:opacity-50 hover:bg-red-700 flex items-center justify-center"
      title="Delete photo"
    >
      <X className="w-4 h-4" />
    </button>
  );
}