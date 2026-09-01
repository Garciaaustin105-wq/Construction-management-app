"use client";

import { useState } from "react";
import Link from "next/link";
import PhotoLightbox from "@/components/PhotoLightbox";
import { CheckCircle2, Camera, Clock, Users, ChevronDown, ChevronRight } from "lucide-react";
import { formatDueStamp } from "@/lib/orgDate";

// A completed visit is a small evidence bundle: what was done, when, how long
// it took, and what it looked like. The list stays compact and expands on
// demand, because the common question is "did we do that one" (scan) and the
// rarer one is "show me" (open).

export type CompletedPhoto = {
  id: string;
  storage_path: string;
  caption: string | null;
  created_at: string;
  phase: "before" | "after" | null;
};

export type CompletedVisit = {
  id: string;
  dueDate: string;
  completedAt: string | null;
  jobName: string;
  address: string | null;
  customerName: string | null;
  minutes: number | null;
  /** Where the duration came from. Measured beats tapped and is labelled as
   *  such, because one is observed and the other is self-reported. */
  minutesSource: "measured" | "tapped" | null;
  phones: number;
  notes: string | null;
  serviceType: string | null;
  photos: CompletedPhoto[];
};

function Row({ visit }: { visit: CompletedVisit }) {
  const [open, setOpen] = useState(false);
  const before = visit.photos.filter((p) => p.phase === "before");
  const after = visit.photos.filter((p) => p.phase === "after");
  const other = visit.photos.filter((p) => p.phase === null);
  const hasPair = before.length > 0 && after.length > 0;

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 truncate">
            {visit.customerName ?? visit.jobName}
            {visit.customerName && (
              <span className="text-gray-400 font-normal"> · {visit.jobName}</span>
            )}
          </p>
          <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 text-green-600" />
              {formatDueStamp(visit.dueDate)}
            </span>
            {visit.minutes !== null && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {visit.minutes} min
                {/* Saying which number this is matters: measured comes from the
                    geofence with nobody tapping anything, tapped is whatever the
                    crew pressed. They are not the same claim. */}
                <span className="text-gray-400">
                  {visit.minutesSource === "measured" ? "measured" : "start→done"}
                </span>
              </span>
            )}
            {visit.phones > 1 && (
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3" />
                {visit.phones} on site
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1 ${
                visit.photos.length === 0 ? "text-gray-300" : ""
              }`}
            >
              <Camera className="w-3 h-3" />
              {visit.photos.length === 0
                ? "no photos"
                : `${visit.photos.length} photo${visit.photos.length === 1 ? "" : "s"}`}
              {hasPair && <span className="text-green-700 font-medium">· pair</span>}
            </span>
          </p>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 space-y-3">
          {/* Everything the office would otherwise open the visit page for.
              The link below stays as the escape hatch, but browsing a list of
              finished work should not cost two page loads and a lost place. */}
          <div className="space-y-1">
            {visit.address && <p className="text-xs text-gray-500">{visit.address}</p>}
            {visit.serviceType && (
              <p className="text-xs text-gray-500">Service: {visit.serviceType}</p>
            )}
            {visit.completedAt && (
              <p className="text-xs text-gray-500">
                Marked done {new Date(visit.completedAt).toLocaleString()}
              </p>
            )}
            {visit.notes && (
              <p className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap">
                {visit.notes}
              </p>
            )}
          </div>

          {visit.photos.length === 0 ? (
            <p className="text-xs text-gray-400 italic">
              No photos were taken on this visit.
            </p>
          ) : (
            <div className="space-y-3">
              {(before.length > 0 || after.length > 0) && (
                <div className="grid grid-cols-2 gap-4">
                  {([["before", before], ["after", after]] as const).map(([label, list]) => (
                    <div key={label} className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                        {label}
                      </p>
                      {list.length === 0 ? (
                        <p className="text-[11px] text-gray-400 italic">none taken</p>
                      ) : (
                        <PhotoLightbox photos={list} />
                      )}
                    </div>
                  ))}
                </div>
              )}
              {other.length > 0 && (
                <div className="space-y-1.5">
                  {(before.length > 0 || after.length > 0) && (
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      other
                    </p>
                  )}
                  <PhotoLightbox photos={other} />
                </div>
              )}
            </div>
          )}

          <Link
            href={`/lawn/visits/${visit.id}?from=completed`}
            className="inline-block text-xs text-blue-700 hover:underline"
          >
            Open the full visit →
          </Link>
        </div>
      )}
    </div>
  );
}

export default function CompletedVisitsList({ visits }: { visits: CompletedVisit[] }) {
  if (visits.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm text-center py-12 px-4">
        <CheckCircle2 className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm font-medium text-gray-700">Nothing completed yet</p>
        <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto">
          Visits appear here once a crew marks them done, together with any
          photos and the time recorded against them.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      {visits.map((v) => (
        <Row key={v.id} visit={v} />
      ))}
    </div>
  );
}
