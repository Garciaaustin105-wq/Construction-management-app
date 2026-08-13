"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { signedThumbnail } from "@/lib/storage";
import { FileImage, Sparkles, CornerDownRight, HelpCircle } from "lucide-react";

type Photo = {
  id: string;
  storage_path: string;
  caption: string | null;
  created_at: string;
  uploaded_by: string | null;
};

type Rfi = {
  id: string;
  question: string;
  answer: string | null;
  status: string;
  created_at: string;
  answered_at: string | null;
};

type Job = {
  id: string;
  status: string;
  created_at: string;
};

export default function ActivityTimeline({
  job,
  photos,
  rfis,
}: {
  job: Job;
  photos: Photo[];
  rfis: Rfi[];
}) {
  const supabase = createClient();
  // job-photos is a PRIVATE bucket — mint signed URLs (1h) instead of public URLs.
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function mint() {
      const entries = await Promise.all(
        photos.map(async (p) => {
          // 96px transformed thumbnail for the 12x12 timeline avatar.
          const url = await signedThumbnail(
            supabase,
            "job-photos",
            p.storage_path,
            96
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

  type Event = {
    type: "photo" | "rfi" | "status" | "created";
    timestamp: string;
    data: unknown;
  };

  const events: Event[] = [];

  events.push({ type: "created", timestamp: job.created_at, data: { status: job.status } });
  for (const p of photos) {
    events.push({ type: "photo", timestamp: p.created_at, data: p });
  }
  for (const r of rfis) {
    events.push({ type: "rfi", timestamp: r.created_at, data: r });
    if (r.answered_at) {
      events.push({
        type: "rfi",
        timestamp: r.answered_at,
        data: { ...r, isAnswer: true },
      });
    }
  }

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
        Activity
      </h2>
      <div className="bg-white rounded-lg shadow-sm divide-y">
        {events.map((e, i) => {
          const time = new Date(e.timestamp).toLocaleString();
          if (e.type === "created") {
            return (
              <div key={i} className="p-3 flex gap-3">
                <Sparkles className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm text-gray-900">Project created</p>
                  <p className="text-xs text-gray-500">{time}</p>
                </div>
              </div>
            );
          }
          if (e.type === "photo") {
            const p = e.data as Photo;
            return (
              <div key={i} className="p-3 flex gap-3">
                <a
                  href={urls[p.id] ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="w-12 h-12 bg-gray-200 rounded overflow-hidden flex-shrink-0"
                >
                  {urls[p.id] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={urls[p.id]}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 flex items-center gap-1">
                    <FileImage className="w-4 h-4 text-gray-500" />
                    Photo uploaded
                    {p.caption && (
                      <span className="text-gray-600"> — {p.caption}</span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500">{time}</p>
                </div>
              </div>
            );
          }
          if (e.type === "rfi") {
            const r = e.data as Rfi & { isAnswer?: boolean };
            return (
              <div key={i} className="p-3 flex gap-3">
                {r.isAnswer ? (
                  <CornerDownRight className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                ) : (
                  <HelpCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900">
                    {r.isAnswer ? "RFI answered" : "RFI submitted"}
                  </p>
                  <p className="text-xs text-gray-700 mt-0.5 truncate">
                    {r.isAnswer ? r.answer : r.question}
                  </p>
                  <p className="text-xs text-gray-500">{time}</p>
                </div>
              </div>
            );
          }
          return null;
        })}
        {events.length <= 1 && (
          <div className="py-6 text-center">
            <p className="text-sm text-gray-500">No activity yet</p>
            <p className="text-xs text-gray-400 mt-1">
              Photos, RFIs, and status updates will appear here.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}