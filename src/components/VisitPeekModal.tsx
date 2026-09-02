"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { X, AlertTriangle } from "lucide-react";
import { formatDueStamp, lateLabel } from "@/lib/orgDate";

// A peek at a lawn visit WITHOUT leaving the page. This is the shared modal
// behind every "tap a visit row" surface: the home Today card and the
// calendar's Agenda list today, with /lawn/overdue to follow. Extracted from
// CompletedVisitsList's VisitModal, which solved the same problem for completed
// visits — a page navigation is a Vercel function invocation (server render,
// Active CPU) for information the page already has in memory, so opening one
// costs nothing: no request, no render, no invocation. The link to the full
// visit page remains at the foot for EDITING, where a real page load is
// actually warranted.
//
// Everything a caller passes must already be in its memory. The prop shape is
// therefore optional wherever a surface legitimately doesn't track a field
// (the home Today card doesn't know crews or scheduled windows) — a missing
// field omits its line rather than triggering a fetch or a wider query.

export type VisitPeekVisit = {
  id: string;
  /** Plain calendar date, "YYYY-MM-DD". */
  dueDate: string;
  status: string;
  jobName: string;
  /** Several lawn visits genuinely have no customer; the modal falls back to
   *  the job name so those never render blank. */
  customerName: string | null;
  address: string | null;
  serviceType: string | null;
  /** Preformatted by the caller ("Unassigned" counts). Null = this surface
   *  doesn't track crews, and no crew line is shown. */
  crewName: string | null;
  /** Preformatted scheduled window ("8:00 AM – 10:00 AM"), null when unset or
   *  when the surface doesn't carry windows. */
  windowLabel: string | null;
  /** Null at every current call site — no surface fetches visit notes yet.
   *  Kept so a surface that already holds notes can pass them through. */
  notes: string | null;
};

const STATUS_CHIP: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  done: "bg-green-100 text-green-800",
  skipped: "bg-red-100 text-red-700",
  paused: "bg-blue-100 text-blue-700",
};

// Overdue/Today/formatDueStamp — same three-way answer the home card and the
// calendar agree on. Local to this file because it renders a CHIP, not a
// bucket; @/lib/orgDate stays date-math only.
function dueChipLabel(dueDate: string, today: string): string {
  if (dueDate < today) return "Overdue";
  if (dueDate === today) return "Today";
  return formatDueStamp(dueDate);
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 w-24 shrink-0">
        {label}
      </span>
      <span className="text-sm text-gray-700 min-w-0">{children}</span>
    </div>
  );
}

/**
 * The peek dialog itself. `today` is the ORGANISATION's today ("YYYY-MM-DD")
 * so "late" means late where the work happens — never derived from
 * toISOString(), which shifted the whole app a day every evening after 20:00
 * Eastern. `from` becomes the visit-page link's ?from= so its back button
 * returns the reader to whichever surface they peeked from.
 */
export default function VisitPeekModal({
  visit,
  today,
  from,
  onClose,
}: {
  visit: VisitPeekVisit;
  today: string;
  from: "home" | "calendar";
  onClose: () => void;
}) {
  // Escape closes, and the page behind stops scrolling. Both are what a phone
  // user expects and neither is free by default — without the scroll lock the
  // list drifts under the sheet while you read.
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

  const primary = visit.customerName ?? visit.jobName;
  const late = lateLabel(visit.dueDate, today);
  const overdue = visit.dueDate < today && visit.status === "pending";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Visit at ${primary}`}
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
              {primary}
              {visit.customerName && (
                <span className="text-gray-400 font-normal"> · {visit.jobName}</span>
              )}
            </p>
            <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium ${
                  STATUS_CHIP[visit.status] ?? "bg-gray-100 text-gray-600"
                }`}
              >
                {overdue && <AlertTriangle className="w-3 h-3 shrink-0" />}
                <span className="capitalize">{visit.status}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                {dueChipLabel(visit.dueDate, today)}
              </span>
              {late && (
                <span className="inline-flex items-center gap-1 text-orange-700 font-medium">
                  {late}
                </span>
              )}
            </p>
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

        <div className="p-4 space-y-2.5">
          {visit.address && <MetaRow label="Address">{visit.address}</MetaRow>}
          {visit.serviceType && <MetaRow label="Service">{visit.serviceType}</MetaRow>}
          {visit.crewName !== null && <MetaRow label="Crew">{visit.crewName}</MetaRow>}
          {visit.windowLabel && <MetaRow label="Window">{visit.windowLabel}</MetaRow>}
          {visit.notes && (
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 w-24 shrink-0">
                Notes
              </span>
              <span className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded p-2 whitespace-pre-wrap min-w-0">
                {visit.notes}
              </span>
            </div>
          )}

          {/* The only reason left to load a real page: editing. Everything
              readable is already above. */}
          <div className="pt-1">
            <Link
              href={`/lawn/visits/${visit.id}?from=${from}`}
              className="inline-block text-xs text-blue-700 hover:underline"
            >
              Open the full visit to edit →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The home Today card's list. Lives beside the modal (not in the server page)
// because opening a peek is client state, and the page is a server component.
// Rows render exactly as they did as <Link>s; only the destination changed —
// a modal opens instead of a navigation.
// ---------------------------------------------------------------------------

export function TodayVisitPeekList({
  visits,
  today,
}: {
  visits: VisitPeekVisit[];
  today: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const open = visits.find((v) => v.id === openId) ?? null;

  return (
    <>
      <div className="divide-y divide-gray-100">
        {visits.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setOpenId(v.id)}
            className="w-full flex justify-between items-start gap-2 py-3 text-left active:bg-gray-50 hover:bg-gray-50"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-gray-900 truncate">
                {v.jobName}
              </p>
              <p className="text-xs text-gray-500 truncate">
                {v.customerName ? `${v.customerName} · ` : ""}
                {v.address ?? "—"}
              </p>
            </div>
            <span
              className={`text-[10px] font-semibold px-2 py-1 rounded ${
                STATUS_CHIP[v.status] ?? "bg-gray-100 text-gray-600"
              } whitespace-nowrap`}
            >
              {dueChipLabel(v.dueDate, today)}
            </span>
          </button>
        ))}
      </div>

      {open && <VisitPeekModal visit={open} today={today} from="home" onClose={close} />}
    </>
  );
}