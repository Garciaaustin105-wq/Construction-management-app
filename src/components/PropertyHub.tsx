"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import PhotoLightbox from "@/components/PhotoLightbox";
import {
  ArrowLeft,
  CheckCircle2,
  Camera,
  ChevronRight,
  Clock,
  Info,
  MapPin,
  Repeat,
  Search,
  Users,
  X,
} from "lucide-react";
import { formatDueStamp, lateLabel } from "@/lib/orgDate";

// The property hub: every customer on the left, that customer's whole history
// on the right — visits, photos, schedules, details — with NO page navigation.
//
// Why master–detail and not pages: answering "when did we last cut the
// Hendersons, and what did it look like" used to mean four page loads
// (/lawn/jobs, /lawn/completed, /lawn/photos, the calendar) and losing your
// place each time. Everything the right pane shows was fetched ONCE by the
// server component and handed down as props, so selecting a customer, opening
// a visit, and switching tabs cost no request and no navigation. A
// navigation is a Vercel function invocation for data the page already has.
//
// The one legitimate navigation is EDITING — the Details tab links out to the
// customer record, exactly as CompletedVisitsList keeps its "open to edit"
// link. Reading is free here; editing warrants a real page.

export type HubPhoto = {
  id: string;
  visitId: string;
  storage_path: string;
  caption: string | null;
  created_at: string;
  phase: "before" | "after" | null;
};

export type HubVisit = {
  id: string;
  jobId: string;
  jobName: string;
  address: string | null;
  dueDate: string;
  status: string;
  completedAt: string | null;
  serviceType: string | null;
  notes: string | null;
  minutes: number | null;
  /** Measured (geofence) beats start→done (tapped), and the label says which. */
  minutesSource: "measured" | "tapped" | null;
  onSiteCount: number;
  photos: HubPhoto[];
};

export type HubSchedule = {
  id: string;
  jobId: string;
  jobName: string;
  serviceType: string | null;
  frequency: string | null;
  intervalWeeks: number | null;
  active: boolean;
  pricePerVisit: number | null;
  /** Max due_date among this schedule's DONE visits. */
  lastCompletedDate: string | null;
  /** Min due_date among this schedule's PENDING visits. */
  nextDueDate: string | null;
};

export type HubProperty = {
  id: string;
  name: string;
  address: string | null;
};

export type HubCustomer = {
  /* null = the "No customer assigned" bucket for jobs whose customer row is
   * missing. Those properties must still be reachable (several of Terra
   * Verde's overdue visits have no customer at all), so they get their own
   * rail entry at the bottom rather than being silently dropped. */
  id: string | null;
  /* A labelled synthetic entry (the no-customer bucket) rather than a real
   * customer record — rendered grey/italic and always sorted last. Crew
   * fallback groups (one per property, when the caller cannot read the
   * customers table) are also id:null but are NOT placeholders. */
  placeholder?: boolean;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  properties: HubProperty[];
  visits: HubVisit[];
  schedules: HubSchedule[];
};

const NO_CUSTOMER_KEY = "__no_customer__";

type Tab = "visits" | "photos" | "schedule" | "details";

const TABS: { key: Tab; label: string }[] = [
  { key: "visits", label: "Visits" },
  { key: "photos", label: "Photos" },
  { key: "schedule", label: "Schedule" },
  { key: "details", label: "Details" },
];

// ── shared bits ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  done: "bg-green-100 text-green-800",
  pending: "bg-blue-100 text-blue-800",
  skipped: "bg-gray-100 text-gray-600",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
        STATUS_STYLES[status] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {status}
    </span>
  );
}

function intervalLabel(
  frequency: string | null,
  weeks: number | null
): string {
  if (weeks && weeks > 0) {
    return weeks === 1 ? "Weekly" : `Every ${weeks} weeks`;
  }
  return frequency || "—";
}

function priceLabel(price: number | null): string {
  if (price === null || Number.isNaN(price)) return "—";
  return `$${price.toFixed(2)}`;
}

// Overdue work sits on top (most overdue first — it is the thing to fix), then
// everything else newest first. "Newest" for done visits is when they were
// completed; for pending/skipped it is the due date.
function sortVisits(
  visits: HubVisit[],
  today: string
): HubVisit[] {
  const overdue: HubVisit[] = [];
  const done: HubVisit[] = [];
  const rest: HubVisit[] = [];
  for (const v of visits) {
    if (v.status === "pending" && v.dueDate < today) overdue.push(v);
    else if (v.status === "done") done.push(v);
    else rest.push(v);
  }
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  done.sort(
    (a, b) =>
      (b.completedAt ?? "").localeCompare(a.completedAt ?? "") ||
      b.dueDate.localeCompare(a.dueDate)
  );
  rest.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  return [...overdue, ...done, ...rest];
}

// ── visit modal ──────────────────────────────────────────────────────────────
// Behaviour copied from CompletedVisitsList's modal (the house idiom): bottom
// sheet on a phone, centred dialog on a desktop, Escape + backdrop click to
// close, document.body scroll lock, role="dialog" + aria-modal. Added here
// because the hub needs it too: focus is TRAPPED inside while open and
// restored to the previously-focused element on close.

function VisitModal({
  visit,
  onClose,
}: {
  visit: HubVisit;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const before = visit.photos.filter((p) => p.phase === "before");
  const after = visit.photos.filter((p) => p.phase === "after");
  const other = visit.photos.filter((p) => p.phase === null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Move focus in so keyboard and screen-reader users land INSIDE the dialog.
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Hand focus back to whatever opened the modal.
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Visit at ${visit.jobName} on ${formatDueStamp(visit.dueDate)}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {visit.jobName}
            </p>
            <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-green-600" />
                {formatDueStamp(visit.dueDate)}
              </span>
              <StatusPill status={visit.status} />
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

        <div className="p-4 space-y-4">
          <div className="space-y-1">
            {visit.address && (
              <p className="text-xs text-gray-500">{visit.address}</p>
            )}
            {visit.serviceType && (
              <p className="text-xs text-gray-500">
                Service: {visit.serviceType}
              </p>
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
                  {(
                    [
                      ["before", before],
                      ["after", after],
                    ] as const
                  ).map(([label, list]) => (
                    <div key={label} className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                        {label}
                      </p>
                      {list.length === 0 ? (
                        <p className="text-[11px] text-gray-400 italic">
                          none taken
                        </p>
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

          {/* Editing is the one thing a modal should not pretend to do — the
              full visit page remains the write surface. */}
          <Link
            href={`/lawn/visits/${visit.id}?from=hub`}
            className="inline-block text-xs text-blue-700 hover:underline"
          >
            Open the full visit to edit →
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────

function durationLabel(visit: HubVisit): string | null {
  if (visit.minutes === null) return null;
  const src =
    visit.minutesSource === "measured" ? "measured" : "start→done";
  return `${visit.minutes} min (${src})`;
}

function VisitsTab({
  customer,
  today,
  onOpen,
}: {
  customer: HubCustomer;
  today: string;
  onOpen: (v: HubVisit) => void;
}) {
  const visits = useMemo(() => sortVisits(customer.visits, today), [customer.visits, today]);
  if (visits.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center">
        No visits recorded for this customer yet.
      </p>
    );
  }
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      {visits.map((v) => {
        const late = v.status === "pending" && v.dueDate < today;
        const duration = durationLabel(v);
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onOpen(v)}
            className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">
                {v.jobName}
                <span className="ml-2 align-middle">
                  <StatusPill status={v.status} />
                </span>
                {late && (
                  <span className="ml-2 text-[11px] font-medium text-red-700">
                    {lateLabel(v.dueDate, today)}
                  </span>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{formatDueStamp(v.dueDate)}</span>
                {v.serviceType && <span>{v.serviceType}</span>}
                {duration && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {duration}
                  </span>
                )}
                {v.onSiteCount > 1 && (
                  <span className="inline-flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {v.onSiteCount} on site
                  </span>
                )}
                <span
                  className={`inline-flex items-center gap-1 ${
                    v.photos.length === 0 ? "text-gray-300" : ""
                  }`}
                >
                  <Camera className="w-3 h-3" />
                  {v.photos.length === 0
                    ? "no photos"
                    : `${v.photos.length} photo${v.photos.length === 1 ? "" : "s"}`}
                </span>
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-300 mt-1 shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

// Same before/after treatment as LawnPhotoGallery, scoped to one customer:
// property, then visit, then the pair side by side.
function PhotosTab({ customer }: { customer: HubCustomer }) {
  const groups = useMemo(() => {
    const byVisit = new Map(
      customer.visits.map((v) => [v.id, v] as const)
    );
    // Property → visit → photo side. A photo with no visit still shows (in a
    // per-property "loose photos" bucket) — it is just not part of a pair.
    const jobs = new Map<string, Map<string, HubPhoto[]>>();
    const meta = new Map<string, { jobName: string; dueDate: string | null }>();
    for (const p of customer.visits.flatMap((v) => v.photos)) {
      const visit = byVisit.get(p.visitId);
      const jobName = visit?.jobName ?? "Unknown property";
      const key = p.visitId ?? "";
      const m = jobs.get(jobName) ?? new Map<string, HubPhoto[]>();
      const arr = m.get(key) ?? [];
      arr.push(p);
      m.set(key, arr);
      jobs.set(jobName, m);
      if (!meta.has(key)) {
        meta.set(key, {
          jobName,
          dueDate: visit?.dueDate ?? null,
        });
      }
    }
    return { jobs, meta };
  }, [customer.visits]);

  if (groups.jobs.size === 0) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center">
        No photos for this customer yet. Crews add before and after photos from
        a visit.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {Array.from(groups.jobs.entries()).map(([jobName, visits]) => (
        <div key={jobName} className="bg-white rounded-lg shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
            <h3 className="text-sm font-semibold text-gray-800">{jobName}</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {Array.from(visits.entries()).map(([visitKey, photos]) => {
              const m = groups.meta.get(visitKey);
              const before = photos.filter((p) => p.phase === "before");
              const after = photos.filter((p) => p.phase === "after");
              const other = photos.filter((p) => p.phase === null);
              const hasPair = before.length > 0 && after.length > 0;
              return (
                <div key={visitKey || "loose"} className="p-4 space-y-3">
                  <p className="text-xs text-gray-500">
                    {m?.dueDate ? `Visit ${formatDueStamp(m.dueDate)}` : "Not linked to a visit"}
                    {hasPair && (
                      <span className="ml-2 text-green-700 font-medium">
                        before &amp; after
                      </span>
                    )}
                  </p>
                  {(before.length > 0 || after.length > 0) && (
                    <div className="grid grid-cols-2 gap-4">
                      {(["before", "after"] as const).map((side) => {
                        const list = side === "before" ? before : after;
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
                              <PhotoLightbox photos={list} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {other.length > 0 && (
                    <div className="space-y-2">
                      {(before.length > 0 || after.length > 0) && (
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          other photos
                        </p>
                      )}
                      <PhotoLightbox photos={other} />
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

function ScheduleTab({ customer }: { customer: HubCustomer }) {
  if (customer.schedules.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center">
        No recurring schedules for this customer.
      </p>
    );
  }
  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      {/* Wide table scrolls inside its own container — the page body never
          scrolls sideways. */}
      <div className="overflow-x-auto">
        <table className="min-w-[560px] w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-100">
              <th className="px-4 py-2.5 font-semibold">Property</th>
              <th className="px-4 py-2.5 font-semibold">Service</th>
              <th className="px-4 py-2.5 font-semibold">Interval</th>
              <th className="px-4 py-2.5 font-semibold">Last completed</th>
              <th className="px-4 py-2.5 font-semibold">Next due</th>
              <th className="px-4 py-2.5 font-semibold text-right">Price / visit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {customer.schedules.map((s) => (
              <tr key={s.id} className={s.active ? "" : "text-gray-400"}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {s.jobName}
                  {!s.active && (
                    <span className="ml-2 text-[11px] text-gray-400">
                      off
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {s.serviceType ?? "—"}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  <span className="inline-flex items-center gap-1">
                    <Repeat className="w-3 h-3" />
                    {intervalLabel(s.frequency, s.intervalWeeks)}
                  </span>
                </td>
                {/* Last completed + next due are the two numbers the office
                    reads to confirm a schedule is actually firing. Both are
                    derived from the visits this page already fetched — no
                    extra query, no new column. */}
                <td className="px-4 py-3 text-gray-600">
                  {s.lastCompletedDate ? formatDueStamp(s.lastCompletedDate) : "—"}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {s.nextDueDate ? formatDueStamp(s.nextDueDate) : "—"}
                </td>
                <td className="px-4 py-3 text-right text-gray-900 tabular-nums">
                  {priceLabel(s.pricePerVisit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailsTab({ customer }: { customer: HubCustomer }) {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow-sm p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Customer
          </p>
          <p className="text-gray-900">{customer.name}</p>
        </div>
        {customer.contactName && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Contact
            </p>
            <p className="text-gray-900">{customer.contactName}</p>
          </div>
        )}
        {customer.phone && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Phone
            </p>
            <p className="text-gray-900">{customer.phone}</p>
          </div>
        )}
        {customer.contactEmail && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Email
            </p>
            <p className="text-gray-900 break-all">{customer.contactEmail}</p>
          </div>
        )}
        {customer.address && (
          <div className="sm:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Address
            </p>
            <p className="text-gray-900">{customer.address}</p>
          </div>
        )}
        {customer.notes && (
          <div className="sm:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              Notes
            </p>
            <p className="text-gray-700 whitespace-pre-wrap">{customer.notes}</p>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-gray-400" />
            Properties
          </h3>
        </div>
        <div className="divide-y divide-gray-100">
          {customer.properties.map((p) => (
            <div key={p.id} className="px-4 py-3">
              <p className="text-sm font-medium text-gray-900">{p.name}</p>
              {p.address && <p className="text-xs text-gray-500 mt-0.5">{p.address}</p>}
            </div>
          ))}
        </div>
      </div>

      {/* Read-only hub: editing lives on the existing customer record page.
          This is the one intentional navigation. */}
      {customer.id && (
        <Link
          href={`/admin/customers/${customer.id}`}
          className="inline-block text-xs text-blue-700 hover:underline"
        >
          Open the customer record to edit →
        </Link>
      )}
    </div>
  );
}

// ── the hub ──────────────────────────────────────────────────────────────────

function overdueCount(customer: HubCustomer, today: string): number {
  return customer.visits.filter(
    (v) => v.status === "pending" && v.dueDate < today
  ).length;
}

export default function PropertyHub({
  customers,
  today,
}: {
  customers: HubCustomer[];
  /** The org's calendar "today" (YYYY-MM-DD, from todayInZone). Passed in so
   *  lateness can never drift with the viewer's clock. */
  today: string;
}) {
  // "lg" is the same breakpoint useIsDesktop/Providers use for the sidebar, so
  // master–detail switches exactly where the layout gains a second column.
  const [isDesktop, setDesktop] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>(NO_CUSTOMER_KEY);
  const [tab, setTab] = useState<Tab>("visits");
  const [query, setQuery] = useState("");
  const [openVisit, setOpenVisit] = useState<HubVisit | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Placeholder entries (the no-customer bucket) always sort last, search or
  // no search — a labelled entry at the bottom, never nowhere. Everything else
  // keeps the server's order (customers alphabetical).
  const ordered = useMemo(() => {
    const real = customers.filter((c) => !c.placeholder);
    const none = customers.filter((c) => c.placeholder);
    return [...real, ...none];
  }, [customers]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (c: HubCustomer) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.properties.some((p) => p.name.toLowerCase().includes(q));
    return ordered.filter(matches);
  }, [ordered, query]);

  const selected =
    ordered.find((c) => (c.id ?? NO_CUSTOMER_KEY) === selectedKey) ?? null;

  const rail = (
    <div className={isDesktop ? "h-full flex flex-col" : ""}>
      <div className="p-3 border-b border-gray-100">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers…"
            aria-label="Search customers"
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>
      <div
        className={`flex-1 overflow-y-auto ${
          isDesktop ? "min-h-0" : "max-h-[60vh]"
        }`}
      >
        {visible.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-8 px-4">
            No customers match “{query}”.
          </p>
        )}
        {visible.map((c) => {
          const key = c.id ?? NO_CUSTOMER_KEY;
          const late = overdueCount(c, today);
          const active = selectedKey === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setSelectedKey(key);
                setTab("visits");
                setOpenVisit(null);
              }}
              aria-current={active ? "true" : undefined}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 ${
                active ? "bg-blue-50" : ""
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm truncate ${
                      c.placeholder
                        ? "text-gray-500 italic"
                        : "font-medium text-gray-900"
                    }`}
                  >
                    {c.name}
                  </span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {c.properties.length}{" "}
                    {c.properties.length === 1 ? "property" : "properties"}
                    {late > 0 && (
                      <span className="text-red-700 font-medium">
                        {" "}
                        · {late} overdue
                      </span>
                    )}
                  </span>
                </span>
                <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const close = useCallback(() => setOpenVisit(null), []);

  let detail = null;
  if (selected) {
    const late = overdueCount(selected, today);
    detail = (
      <div className="flex flex-col min-h-0">
        {/* Mobile-only back control: the rail is the page on a phone, and the
            detail slides in over it. Desktop rail persists — no back button
            there, it is always visible. */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 bg-white lg:hidden">
          <button
            type="button"
            onClick={() => setSelectedKey(NO_CUSTOMER_KEY)}
            className="p-1.5 -m-1.5 text-gray-500 hover:text-gray-800"
            aria-label="Back to all customers"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {selected.name}
            </p>
            <p className="text-xs text-gray-500">
              {selected.properties.length}{" "}
              {selected.properties.length === 1 ? "property" : "properties"}
              {late > 0 && (
                <span className="text-red-700 font-medium">
                  {" "}
                  · {late} overdue
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="px-4 pt-3 hidden lg:block">
          <p className="text-sm font-semibold text-gray-900">{selected.name}</p>
          <p className="text-xs text-gray-500">
            {selected.properties.length}{" "}
            {selected.properties.length === 1 ? "property" : "properties"}
            {late > 0 && (
              <span className="text-red-700 font-medium">
                {" "}
                · {late} overdue
              </span>
            )}
          </p>
        </div>

        {/* Tabs are local state — switching never navigates. */}
        <div
          role="tablist"
          aria-label="Customer sections"
          className="flex gap-1 px-4 py-2 border-b border-gray-100 bg-white overflow-x-auto"
        >
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-lg whitespace-nowrap ${
                tab === t.key
                  ? "bg-gray-900 text-white font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="p-4 flex-1 overflow-y-auto min-w-0">
          {tab === "visits" && (
            <VisitsTab customer={selected} today={today} onOpen={setOpenVisit} />
          )}
          {tab === "photos" && <PhotosTab customer={selected} />}
          {tab === "schedule" && <ScheduleTab customer={selected} />}
          {tab === "details" && <DetailsTab customer={selected} />}
        </div>
      </div>
    );
  } else {
    detail = (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 py-16">
        <Info className="w-8 h-8 text-gray-300 mb-2" />
        <p className="text-sm font-medium text-gray-700">
          Select a customer
        </p>
        <p className="text-xs text-gray-500 mt-1 max-w-sm">
          Their visits, photos, schedules and contact details appear here —
          without leaving this page.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop (lg+): both panes, rail persists. Mobile: rail OR detail —
          never both at once (the detail covers the rail when a customer is
          selected; the back arrow returns). Selecting never navigates: no
          router.push, no <Link>, no URL change, no server round trip — the
          data is already in props. */}
      {isDesktop ? (
        <div className="grid grid-cols-[300px_1fr] gap-4 items-start">
          <div className="bg-white rounded-lg shadow-sm overflow-hidden lg:sticky lg:top-4 max-h-[calc(100vh-8rem)]">
            {rail}
          </div>
          <div className="bg-white rounded-lg shadow-sm overflow-hidden min-h-[60vh]">
            {detail}
          </div>
        </div>
      ) : selected ? (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          {detail}
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">{rail}</div>
      )}

      {openVisit && <VisitModal visit={openVisit} onClose={close} />}
    </>
  );
}