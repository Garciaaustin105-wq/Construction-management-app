"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { signedDownload } from "@/lib/storage";

export default function PhotoDownloadButton({
  storagePath,
  bucket = "job-photos",
  className = "",
  label = "Download",
}: {
  storagePath: string;
  bucket?: string;
  className?: string;
  label?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDownload = async () => {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const supabase = createClient();
      const url = await signedDownload(supabase, bucket, storagePath, 3600);

      if (!url) {
        setError("Could not generate download link.");
        setPending(false);
        return;
      }

      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError("Download failed. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onDownload}
      disabled={pending}
      className={className}
      aria-label={label}
      title={error ?? label}
    >
      {pending ? "Preparing..." : label}
    </button>
  );
}