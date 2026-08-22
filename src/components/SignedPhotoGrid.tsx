"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { signedThumbnail } from "@/lib/storage";

// job-photos is a PRIVATE bucket. Thumbnails can't use a public URL, so we mint
// a signed URL per photo on demand (the receipts/blueprints pattern). The
// signed URL is good for 1 hour; this grid is rendered fresh on each navigation.
type Photo = {
  id: string;
  storage_path: string;
  caption?: string | null;
};

export default function SignedPhotoGrid({ photos }: { photos: Photo[] }) {
  const supabase = createClient();
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function mint() {
      const entries = await Promise.all(
        photos.map(async (p) => {
          // 240px transformed thumbnail — KBs, not the full-res original.
          const url = await signedThumbnail(
            supabase,
            "job-photos",
            p.storage_path,
            240
          );
          return [p.id, url] as const;
        })
      );
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [id, url] of entries) if (url) map[id] = url;
      setUrls(map);
    }
    // Always mint — the empty case resolves to setUrls({}) inside the async
    // callback (after Promise.all), keeping setState out of the effect body.
    void mint();
    return () => {
      cancelled = true;
    };
  }, [photos, supabase]);

  if (photos.length === 0) return null;

  return (
    <div className="grid grid-cols-3 gap-2">
      {photos.map((p) =>
        urls[p.id] ? (
          <a
            key={p.id}
            href={urls[p.id]}
            target="_blank"
            rel="noreferrer"
            className="aspect-square bg-gray-200 rounded-lg overflow-hidden block"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={urls[p.id]}
              alt={p.caption ?? ""}
              loading="lazy"
              decoding="async"
              // object-cover fills the square cell (crops to fit, no gray
              // letterbox bars — object-contain read as "smaller/wrong").
              // Fade in on load to skip the stretched pre-object-fit paint.
              className="w-full h-full object-cover opacity-0 transition-opacity duration-300"
              onLoad={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            />
          </a>
        ) : (
          <div
            key={p.id}
            className="aspect-square bg-gray-200 rounded-lg animate-pulse"
          />
        )
      )}
    </div>
  );
}