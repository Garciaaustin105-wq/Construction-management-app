"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { signedThumbnail } from "@/lib/storage";
import PhotoLightbox from "@/components/PhotoLightbox";
import { Camera } from "lucide-react";

// Lawn photo gallery, grouped the way the work actually happened: by property,
// then by visit, then before/after side by side.
//
// This is not the construction gallery with a different filter. Construction
// photos are progress documentation — a flat reverse-chronological wall is the
// right shape for those. Lawn photos exist to prove a yard got cut and to show
// a customer the difference, so the PAIR is the unit, and a flat wall destroys
// exactly the comparison that gives them their value.
//
// job-photos is a PRIVATE bucket, so every thumbnail is a signed URL minted on
// demand (1 hour). Downloads mint their own separately at full resolution —
// orgs use these for advertising, and a 240px thumbnail is useless for that.

export type GalleryPhoto = {
  id: string;
  storage_path: string;
  caption: string | null;
  created_at: string;
  phase: "before" | "after" | null;
  visit_id: string | null;
  job_name: string;
  due_date: string | null;
};

type VisitGroup = {
  visitId: string | null;
  dueDate: string | null;
  before: GalleryPhoto[];
  after: GalleryPhoto[];
  other: GalleryPhoto[];
};

function groupByJobThenVisit(photos: GalleryPhoto[]) {
  const jobs = new Map<string, Map<string, VisitGroup>>();
  for (const p of photos) {
    const visits = jobs.get(p.job_name) ?? new Map<string, VisitGroup>();
    // A photo with no visit is still worth showing — it is just not part of a
    // pair. Keying on "" keeps them together in one bucket per property.
    const key = p.visit_id ?? "";
    const g =
      visits.get(key) ??
      ({ visitId: p.visit_id, dueDate: p.due_date, before: [], after: [], other: [] } as VisitGroup);
    if (p.phase === "before") g.before.push(p);
    else if (p.phase === "after") g.after.push(p);
    else g.other.push(p);
    visits.set(key, g);
    jobs.set(p.job_name, visits);
  }
  return jobs;
}

// No bespoke thumbnail component here. PhotoLightbox already renders a grid,
// mints a full-resolution signed URL on click, and carries PhotoDownloadButton
// inside the modal — so one instance per column gives click-to-enlarge and
// download without duplicating any of it. The pre-minted thumbUrls below are
// handed in so N columns do not each re-mint the same images.

export default function LawnPhotoGallery({ photos }: { photos: GalleryPhoto[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const entries = await Promise.all(
        photos.map(async (p) => {
          const url = await signedThumbnail(supabase, "job-photos", p.storage_path, 320);
          return [p.id, url] as const;
        })
      );
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const [id, url] of entries) if (url) map[id] = url;
      setUrls(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [photos]);

  if (photos.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm text-center py-12 px-4">
        <Camera className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-700">No photos yet</p>
        <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto">
          Crews add before and after photos from a visit. They collect here,
          grouped by property, ready to download for a customer or an advert.
        </p>
      </div>
    );
  }

  const grouped = groupByJobThenVisit(photos);

  return (
    <div className="space-y-6">
      {Array.from(grouped.entries()).map(([jobName, visits]) => (
        <div key={jobName} className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
            <h2 className="text-sm font-semibold text-gray-800">{jobName}</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {Array.from(visits.values()).map((g) => {
              const hasPair = g.before.length > 0 && g.after.length > 0;
              return (
                <div key={g.visitId ?? "loose"} className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-gray-500">
                      {g.dueDate ? `Visit ${g.dueDate}` : "Not linked to a visit"}
                      {hasPair && (
                        <span className="ml-2 text-green-700 font-medium">
                          before &amp; after
                        </span>
                      )}
                    </p>
                    {g.visitId && (
                      <Link
                        href={`/lawn/visits/${g.visitId}?from=photos`}
                        className="text-xs text-blue-700 hover:underline shrink-0"
                      >
                        Open visit
                      </Link>
                    )}
                  </div>

                  {/* Before and after sit side by side so the comparison is the
                      first thing you see. When only one side exists the column
                      still renders, labelled — an absent "after" is itself
                      information (the crew photographed the mess and not the
                      result). */}
                  {(g.before.length > 0 || g.after.length > 0) && (
                    <div className="grid grid-cols-2 gap-4">
                      {(["before", "after"] as const).map((side) => {
                        const list = side === "before" ? g.before : g.after;
                        return (
                          <div key={side} className="space-y-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                              {side}
                            </p>
                            {list.length === 0 ? (
                              <p className="text-[11px] text-gray-400 italic">
                                none taken
                              </p>
                            ) : (
                              <PhotoLightbox
                                photos={list.map((p) => ({
                                  id: p.id,
                                  storage_path: p.storage_path,
                                  caption: p.caption,
                                  created_at: p.created_at,
                                }))}
                                thumbUrls={urls}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {g.other.length > 0 && (
                    <div className="space-y-2">
                      {(g.before.length > 0 || g.after.length > 0) && (
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          other photos
                        </p>
                      )}
                      <PhotoLightbox
                        photos={g.other.map((p) => ({
                          id: p.id,
                          storage_path: p.storage_path,
                          caption: p.caption,
                          created_at: p.created_at,
                        }))}
                        thumbUrls={urls}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
