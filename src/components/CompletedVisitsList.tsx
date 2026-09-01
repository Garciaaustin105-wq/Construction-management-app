"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import PhotoLightbox from "@/components/PhotoLightbox";
import { CheckCircle2, Camera, Clock, Users, X } from "lucide-react";
import { formatDueStamp } from "@/lib/orgDate";

// A completed visit is a small evidence bundle: what was done, when, how long
// it took, and what it looked like.
//
// The detail opens in a MODAL rather than by navigating to /lawn/visits/[id].
// That is not only a nicer read — a page navigation is a Vercel function
// invocation (server render, Active CPU, provisioned memory) for information
// this page has already fetched. Everything the modal shows comes from the list
// query, so opening one costs nothing: no request, no render, no invocation.
// The link to the full visit page remains for EDITING, where a real page load
// is actually warranted.

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

function Meta({ visit }: { visit: CompletedVisit }) {
  const hasPair =
    visit.photos.some((p) => p.phase === "before") &&
    visit.photos.some((p) => p.phase === "after");
  return (
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
              geofence with nobody tapping anything, start→done is whatever the
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
  );
}

function VisitModal({
  visit,
  onClose,
}: {
  visit: CompletedVisit;
  onClose: () => void;
}) {
  const before = visit.photos.filter((p) => p.phase === "before");
  const after = visit.photos.filter((p) => p.phase === "after");
  const other = visit.photos.filter((p) => p.phase === null);

  // Escape closes, and the page behind stops scrolling. Both are what a phone
  // user expects and neither is free by default — without the scroll lock the
  // list drifts under the sheet while you swipe through photos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Visit at ${visit.customerName ?? visit.jobName}`}
      onClick={onClose}
    >
      {/* Bottom sheet on a phone, centred dialog on a desktop. stopPropagation
          is what stops a click INSIDE from reaching the backdrop and closing. */}
      <div
        className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {visit.customerName ?? visit.jobName}
              {visit.customerName && (
                <span className="text-gray-400 font-normal"> · {visit.jobName}</span>
              )}
            </p>
            <Meta visit={visit} />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 -m-1.5 text-gray-400 hover:text-gray-700 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
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

          {/* The only reason left to load a real page: editing. Everything
              readable is already above. */}
          <Link
            href={`/lawn/visits/${visit.id}?from=completed`}
            className="inline-block text-xs text-blue-700 hover:underline"
          >
            Open the full visit to edit →
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function CompletedVisitsList({ visits }: { visits: CompletedVisit[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);

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

  const open = visits.find((v) => v.id === openId) ?? null;

  return (
    <>
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {visits.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setOpenId(v.id)}
            className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">
                {v.customerName ?? v.jobName}
                {v.customerName && (
                  <span className="text-gray-400 font-normal"> · {v.jobName}</span>
                )}
              </p>
              <Meta visit={v} />
            </div>
          </button>
        ))}
      </div>

      {open && <VisitModal visit={open} onClose={close} />}
    </>
  );
}
