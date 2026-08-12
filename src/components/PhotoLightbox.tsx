"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Trash2, User, Clock, MapPin } from "lucide-react";

export default function PhotoLightbox({
  photos,
  canDelete = false,
}: {
  photos: {
    id: string;
    storage_path: string;
    caption: string | null;
    created_at: string;
    uploaded_by_name?: string | null;
    lat?: number | null;
    lng?: number | null;
  }[];
  canDelete?: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [photos_, setPhotos] = useState(photos);
  // job-photos is a PRIVATE bucket — mint a signed URL per photo (1h) instead
  // of using a public URL. Keyed by photo id so survivors stay valid after a
  // delete (we just drop the deleted id from photos_).
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    setPhotos(photos);
  }, [photos]);

  useEffect(() => {
    let cancelled = false;
    async function mint() {
      const entries = await Promise.all(
        photos.map(async (p) => {
          const { data } = await supabase.storage
            .from("job-photos")
            .createSignedUrl(p.storage_path, 3600);
          return [p.id, data?.signedUrl ?? null] as const;
        })
      );
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [id, url] of entries) if (url) map[id] = url;
      setUrls(map);
    }
    if (photos.length > 0) mint();
    else setUrls({});
    return () => {
      cancelled = true;
    };
  }, [photos, supabase]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight")
        setIndex((i) => Math.min(photos_.length - 1, i + 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, photos_.length]);

  if (photos_.length === 0) return null;
  const current = photos_[index];

  async function handleDelete() {
    if (!confirm(`Delete this photo? This can't be undone.`)) return;
    await supabase.storage.from("job-photos").remove([current.storage_path]);
    await supabase.from("photos").delete().eq("id", current.id);
    const next = photos_.filter((p) => p.id !== current.id);
    setPhotos(next);
    if (next.length === 0) setOpen(false);
    else if (index >= next.length) setIndex(next.length - 1);
    router.refresh();
  }

  return (
    <>
      {/* Thumbnail grid */}
      <div className="grid grid-cols-3 gap-2">
        {photos_.map((p, i) => (
          <button
            key={p.id}
            onClick={() => {
              setIndex(i);
              setOpen(true);
            }}
            className="aspect-square bg-gray-200 rounded-lg overflow-hidden active:opacity-70 relative"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={urls[p.id] ?? ""}
              alt={p.caption ?? ""}
              className="w-full h-full object-cover"
            />
            {p.caption && (
              <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs p-1 truncate">
                {p.caption}
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Lightbox overlay */}
      {open && (
        <div
          className="fixed inset-0 z-[100] bg-black flex flex-col"
          onClick={() => setOpen(false)}
        >
          <div className="flex items-center justify-between p-3 text-white">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className="text-white p-2"
              title="Close"
            >
              <X className="w-6 h-6" />
            </button>
            <span className="text-sm">
              {index + 1} / {photos_.length}
            </span>
            {canDelete ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="text-red-400 p-2"
                title="Delete"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            ) : (
              <div className="w-8" />
            )}
          </div>

          <div
            className="flex-1 flex items-center justify-center p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={urls[current.id] ?? ""}
              alt={current.caption ?? ""}
              className="max-w-full max-h-full object-contain"
            />
          </div>

          <div className="flex justify-between items-center p-4 text-white">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIndex((i) => Math.max(0, i - 1));
              }}
              disabled={index === 0}
              className="disabled:opacity-30 p-2 self-start"
              title="Previous"
            >
              <ChevronLeft className="w-7 h-7" />
            </button>
            <div className="flex-1 px-2 max-w-md">
              {current.caption && (
                <p className="text-sm text-center mb-2">{current.caption}</p>
              )}
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-gray-300">
                {current.uploaded_by_name && (
                  <span className="inline-flex items-center gap-1">
                    <User className="w-3.5 h-3.5" />
                    {current.uploaded_by_name}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  {new Date(current.created_at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
                {typeof current.lat === "number" &&
                  typeof current.lng === "number" && (
                    <a
                      href={`https://www.google.com/maps?q=${current.lat},${current.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-blue-300 hover:text-blue-200 underline"
                    >
                      <MapPin className="w-3.5 h-3.5" />
                      {current.lat.toFixed(4)}, {current.lng.toFixed(4)}
                    </a>
                  )}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIndex((i) => Math.min(photos_.length - 1, i + 1));
              }}
              disabled={index === photos_.length - 1}
              className="disabled:opacity-30 p-2 self-start"
              title="Next"
            >
              <ChevronRight className="w-7 h-7" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}