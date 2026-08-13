"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { signedThumbnail, signedFull } from "@/lib/storage";
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
  // Full-res URL for the currently-open lightbox photo, minted on demand (one
  // call) instead of up front for every photo. Paired with the path it was
  // minted for so a stale value from a previous photo never renders — the
  // lightbox falls back to the thumbnail until the matching full-res resolves.
  const [fullRes, setFullRes] = useState<{ path: string; url: string } | null>(
    null
  );
  // Touch swipe tracking for mobile next/prev navigation.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Locally-deleted photo ids, remembered for the component's lifetime. Both
  // the prop-sync effect and the signed-URL effect filter these out so a stale
  // read-after-write re-fetch (triggered by router.refresh() after a delete)
  // can never resurrect a deleted row with a now-404 signed URL — which was the
  // cause of the blank-card / no-auto-advance bug on mobile.
  const deletedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    setPhotos(photos.filter((p) => !deletedIds.current.has(p.id)));
  }, [photos]);

  useEffect(() => {
    let cancelled = false;
    async function mint() {
      const live = photos.filter((p) => !deletedIds.current.has(p.id));
      const entries = await Promise.all(
        live.map(async (p) => {
          // 240px transformed thumbnail — KBs, not the multi-MB original.
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
    // callback (after Promise.all), which keeps setState out of the effect body
    // (react-hooks/set-state-in-effect). Synchronous setUrls({}) here would
    // trigger a cascading render.
    void mint();
    return () => {
      cancelled = true;
    };
  }, [photos, supabase]);

  // Mint the full-res URL only for the photo the lightbox is actually showing
  // — one request on open/swipe, not N up front. The thumbnail (urls[id]) shows
  // until it resolves, then the image upgrades.
  useEffect(() => {
    if (!open) return;
    const path = photos_[index]?.storage_path;
    if (!path) return;
    let cancelled = false;
    (async () => {
      const url = await signedFull(supabase, "job-photos", path);
      if (!cancelled && url) setFullRes({ path, url });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, index, photos_, supabase]);

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
    const victim = current;
    // Remove the storage object, then the DB row. We gate on the DB delete —
    // if it fails, leave the photo in place and surface the error instead of
    // dropping it from the grid into a broken state. (A storage-remove failure
    // while the row deletes is harmless: the row is gone so the app won't show
    // it; the orphaned object is a minor storage cleanup issue.)
    await supabase.storage.from("job-photos").remove([victim.storage_path]);
    const { error } = await supabase.from("photos").delete().eq("id", victim.id);
    if (error) {
      alert("Could not delete the photo. Try again.");
      return;
    }
    // Remember the deletion so the prop-sync + URL effects never bring it back,
    // and drop its signed URL immediately so the grid doesn't flash a broken
    // image during the router.refresh() re-mint window.
    deletedIds.current.add(victim.id);
    setUrls((prev) => {
      const next = { ...prev };
      delete next[victim.id];
      return next;
    });
    const next = photos_.filter((p) => p.id !== victim.id);
    setPhotos(next);
    if (next.length === 0) setOpen(false);
    else if (index >= next.length) setIndex(next.length - 1);
    // index otherwise stays put — after a middle-of-list delete, later items
    // shift down so photos_[index] is already the NEXT photo (auto-advance).
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
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
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
            className="flex-1 min-h-0 flex items-center justify-center p-4"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => {
              const t = e.touches[0];
              touchStart.current = { x: t.clientX, y: t.clientY };
            }}
            onTouchEnd={(e) => {
              const start = touchStart.current;
              if (!start) return;
              const t = e.changedTouches[0];
              const dx = t.clientX - start.x;
              const dy = t.clientY - start.y;
              touchStart.current = null;
              // Only treat as a horizontal swipe if the horizontal movement is
              // dominant and over ~40px; otherwise leave it as a tap.
              if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
              if (dx < 0) {
                setIndex((i) => Math.min(photos_.length - 1, i + 1));
              } else {
                setIndex((i) => Math.max(0, i - 1));
              }
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={
                (fullRes?.path === current.storage_path
                  ? fullRes.url
                  : urls[current.id]) ?? ""
              }
              alt={current.caption ?? ""}
              className="max-w-full max-h-full object-contain"
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
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