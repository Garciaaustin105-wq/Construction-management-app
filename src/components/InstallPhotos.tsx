"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Images } from "lucide-react";

type Photo = {
  id: string;
  storage_path: string;
  caption: string | null;
  created_at: string;
};

// Install photo grid. `job-photos` is a PRIVATE bucket, so paths have to be
// signed before they can be rendered — same approach as the existing photo
// surfaces (SignedPhotoGrid / BlueprintsSection). Signing happens client-side
// on mount so the server page stays cacheable and doesn't block on N signing
// round trips.
//
// Storage RLS ("Read install photos", isp_module_storage.sql) decides whether
// signing succeeds at all: office in the install's org, or assigned crew. A
// path that fails to sign is skipped rather than rendering a broken image.
export default function InstallPhotos({ photos }: { photos: Photo[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (photos.length === 0) return;
    let cancelled = false;
    const supabase = createClient();

    (async () => {
      const { data } = await supabase.storage
        .from("job-photos")
        .createSignedUrls(
          photos.map((p) => p.storage_path),
          3600
        );
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      data.forEach((row, i) => {
        if (row.signedUrl) next[photos[i].id] = row.signedUrl;
      });
      setUrls(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [photos]);

  if (photos.length === 0) return null;

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <Images className="w-4 h-4" /> Photos
        <span className="text-xs font-normal text-gray-500">{photos.length}</span>
      </h2>
      <div className="grid grid-cols-3 gap-2">
        {photos.map((p) => {
          const url = urls[p.id];
          return (
            <a
              key={p.id}
              href={url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="block aspect-square rounded-lg overflow-hidden bg-gray-100"
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt={p.caption ?? "Install photo"}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="block w-full h-full animate-pulse bg-gray-200" />
              )}
            </a>
          );
        })}
      </div>
    </section>
  );
}
