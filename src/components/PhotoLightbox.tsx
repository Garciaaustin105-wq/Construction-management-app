"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

export default function PhotoLightbox({
  photos,
  baseUrl,
  canDelete = false,
}: {
  photos: { id: string; storage_path: string; caption: string | null; created_at: string }[];
  baseUrl: string;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [photos_, setPhotos] = useState(photos);

  useEffect(() => {
    setPhotos(photos);
  }, [photos]);

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
              src={baseUrl + p.storage_path}
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
              src={baseUrl + current.storage_path}
              alt={current.caption ?? ""}
              className="max-w-full max-h-full object-contain"
            />
          </div>

          <div className="flex justify-between p-4 text-white">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIndex((i) => Math.max(0, i - 1));
              }}
              disabled={index === 0}
              className="disabled:opacity-30 p-2"
              title="Previous"
            >
              <ChevronLeft className="w-7 h-7" />
            </button>
            <div className="flex-1 px-4">
              {current.caption && (
                <p className="text-sm text-center truncate">{current.caption}</p>
              )}
              <p className="text-xs text-center text-gray-400">
                {new Date(current.created_at).toLocaleString()}
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIndex((i) => Math.min(photos_.length - 1, i + 1));
              }}
              disabled={index === photos_.length - 1}
              className="disabled:opacity-30 p-2"
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