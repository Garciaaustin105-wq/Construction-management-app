"use client";

import { useMemo, useState, useEffect, useCallback, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Search, CalendarDays, ChevronLeft, ChevronRight, AlertTriangle, CloudRain, X } from "lucide-react";
import RecurringScheduleEditor from "@/components/RecurringScheduleEditor";
import VisitPeekModal, { type VisitPeekVisit } from "@/components/VisitPeekModal";
import { lateLabel } from "@/lib/orgDate";

export type BoardVisit = {
  id: string;
  due_date: string; // "YYYY-MM-DD"
  status: "pending" | "done" | "skipped" | "paused";
  crew_id: string | null;
  job_name: string;
  /** Null is normal: a job can exist with no customer record. */
  customer_name: string | null;
  address: string | null;
  service_type: string | null;
  // Needed so a crew-reassign drag can offer to also set the schedule's
  // default crew (recurring_schedules.default_crew_id) for future visits.
  recurring_schedule_id: string;
  // Postgres `time` values ("HH:MM:SS"), only used by Day view. Most visits
  // don't have one set -- those sort last and show no time label.
  scheduled_window_start: string | null;
  scheduled_window_end: string | null;
  // The first service_zones circle (of the org's active zones) whose
  // center+radius contains the job's map pin, computed server-side — null
  // when the job has no pin or falls outside every zone.
  zone_id: string | null;
};

// Mirrors RecurringScheduleEditor's `initial` prop shape exactly, so a fetched
// row can be handed straight through with no reshaping.
export type ScheduleDetail = {
  id: string;
  frequency: "weekly" | "biweekly" | "monthly";
  interval_weeks: number;
  days_of_week: number[];
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  service_type: string | null;
  price_per_visit: number;
  notes: string | null;
  estimated_duration_minutes: number | null;
};

export type BoardCrew = {
  id: string;
  name: string;
  // 1=Sun..7=Sat (matches the crew_has_capacity() DB function's convention,
  // NOT this app's usual 0=Sun..6=Sat) -- null/empty = works any day.
  working_days: number[] | null;
  max_visits_per_day: number | null;
};

export type LawnCalendarBoardProps = {
  view: "month" | "week" | "day" | "agenda";
  todayIso: string; // "YYYY-MM-DD"
  visits: BoardVisit[];
  crews: BoardCrew[];
  serviceTypes: string[];
  zones: { id: string; name: string }[];
  // ISO dates flagged as rain-risk by the NWS forecast (same data source as
  // /lawn/weather) — only ever populated for dates within that board's
  // ~10-day window; further-out dates just show no flag.
  rainRiskDates: string[];
  month?: {
    monthLabel: string;
    cells: (string | null)[];
    prevHref: string;
    nextHref: string;
    todayHref: string;
    isCurrentMonth: boolean;
  };
  week?: {
    days: string[];
    prevHref: string;
    nextHref: string;
    todayHref: string;
  };
  day?: {
    date: string; // "YYYY-MM-DD"
    label: string; // already formatted, e.g. "Monday, Sep 15"
    prevHref: string;
    nextHref: string;
    todayHref: string;
    isToday: boolean;
  };
  monthViewHref: string;
  weekViewHref: string;
  dayViewHref: string;
  agendaViewHref: string;
  // Inline schedule editing — clicking a chip in Month/Week/Day opens
  // RecurringScheduleEditor in a modal (Agenda rows stay plain visit links).
  // Keyed by recurring_schedule_id, scoped server-side to only the schedules
  // visible in the current range.
  schedules: Record<string, ScheduleDetail>;
  lawnServices: { id: string; name: string; default_price: number; default_duration_minutes: number | null }[];
  canEdit: boolean;
};

const CREW_COLORS = [
  { dot: "bg-blue-500", chip: "bg-blue-50 text-blue-800 border border-blue-200" },
  { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-800 border border-emerald-200" },
  { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 border border-amber-200" },
  { dot: "bg-purple-500", chip: "bg-purple-50 text-purple-800 border border-purple-200" },
  { dot: "bg-pink-500", chip: "bg-pink-50 text-pink-800 border border-pink-200" },
  { dot: "bg-cyan-500", chip: "bg-cyan-50 text-cyan-800 border border-cyan-200" },
  { dot: "bg-orange-500", chip: "bg-orange-50 text-orange-800 border border-orange-200" },
  { dot: "bg-indigo-500", chip: "bg-indigo-50 text-indigo-800 border border-indigo-200" },
];
const UNASSIGNED_COLOR = { dot: "bg-gray-400", chip: "bg-gray-50 text-gray-600 border border-gray-200" };

const MAX_CHIPS_PER_CELL = 3;
const MAX_CHIPS_PER_CELL_DESKTOP = 6;

const FILTER_PILL = "inline-flex rounded-lg border border-gray-200 bg-white p-0.5 self-start";
const FILTER_BTN = (active: boolean) =>
  `px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
    active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50"
  }`;

// "08:00:00" -> "8:00 AM". Returns null for an unset/unparseable window so
// callers can decide what to show in its place.
function formatWindowTime(t: string | null): string | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${min} ${ampm}`;
}

const STATUS_BADGE: Record<BoardVisit["status"], string> = {
  done: "bg-gray-100 text-gray-500",
  // Distinct from "done" on purpose — a skipped visit needs a human decision
  // (reschedule, or leave it), it isn't finished work like "done" is.
  skipped: "bg-red-100 text-red-700",
  pending: "bg-amber-100 text-amber-700",
  paused: "bg-blue-100 text-blue-700",
};

// BoardVisit -> the shared peek modal's shape. Everything comes from the row
// the board already holds, so opening a peek fetches nothing. The crew name is
// passed in preformatted (nameFor already resolves "Unassigned"); the window
// reuses this file's formatWindowTime, so the HH:MM:SS formatting stays in
// exactly one place.
function toPeekVisit(v: BoardVisit, crewName: string): VisitPeekVisit {
  return {
    id: v.id,
    dueDate: v.due_date,
    status: v.status,
    jobName: v.job_name,
    customerName: v.customer_name,
    address: v.address,
    serviceType: v.service_type,
    crewName,
    windowLabel:
      [formatWindowTime(v.scheduled_window_start), formatWindowTime(v.scheduled_window_end)]
        .filter(Boolean)
        .join(" – ") || null,
    // The board's query doesn't carry visit notes; none of its surfaces showed
    // them before, so the modal omits the line rather than widening the fetch.
    notes: null,
  };
}

// A day cell (month) or day×crew cell (week) that visits can be dropped onto.
// One useDroppable call per mounted cell, at this component's own top level —
// NOT inline inside a parent .map() callback (that would call the hook a
// varying number of times per render and crash).
function DroppableCell({
  id,
  className,
  children,
}: {
  id: string;
  className: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className} ${isOver ? "bg-blue-50 ring-1 ring-blue-300" : ""}`}>
      {children}
    </div>
  );
}

// A draggable visit chip. One useDraggable call per mounted chip, at this
// component's own top level — same reasoning as DroppableCell above.
function DraggableChip({
  visit,
  crewName,
  today,
  color,
  extraClassName,
  showTime,
  onClick,
}: {
  visit: BoardVisit;
  crewName: string;
  /** The organisation's today, so "late" means late where the work happens. */
  today: string;
  color: { dot: string; chip: string };
  extraClassName?: string;
  // Day view only — prefixes the chip with its scheduled window, if set.
  showTime?: boolean;
  // Opens the schedule editor modal. A plain click (no drag movement) still
  // fires this — dnd-kit's PointerSensor only starts a drag past its 6px
  // activation distance, so a tap-and-release passes through as a click.
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: visit.id });
  const style: CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
  };
  const skipped = visit.status === "skipped";
  // OVERDUE is derived, not stored. A visit due tomorrow and one due seven days
  // ago both carry status "pending"; only the date separates them, and without
  // this the calendar cannot show the difference at all.
  const overdue = visit.status === "pending" && visit.due_date < today;
  const late = overdue ? lateLabel(visit.due_date, today) : "";
  // The customer is what a crew recognises — "the Hendersons", not "job 4c1".
  // Crew assignment is secondary; it used to be the loudest thing on the chip,
  // which is why an unassigned day read as a wall of "Unassigned".
  const primary = visit.customer_name ?? visit.job_name;
  const timeLabel = showTime ? formatWindowTime(visit.scheduled_window_start) : null;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={
        skipped
          ? "Skipped — needs a follow-up"
          : overdue
            ? `${primary} — ${late}, still pending`
            : onClick
              ? "Click to edit this schedule"
              : undefined
      }
      className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate cursor-grab active:cursor-grabbing ${
        skipped
          ? "bg-red-50 text-red-700 border border-red-200 line-through"
          : overdue
            ? "bg-orange-100 text-orange-900 border border-orange-300 font-medium"
            : color.chip
      } ${isDragging ? "opacity-60" : ""} ${extraClassName ?? ""}`}
    >
      {skipped ? (
        <AlertTriangle className="inline-block w-2.5 h-2.5 mr-1 align-middle shrink-0" />
      ) : overdue ? (
        <AlertTriangle className="inline-block w-2.5 h-2.5 mr-1 align-middle shrink-0 text-orange-600" />
      ) : (
        <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${color.dot}`} />
      )}
      {timeLabel && <span className="font-mono text-[9px] text-gray-500 align-middle mr-1">{timeLabel}</span>}
      {/* Customer leads. Crew and service follow, muted — they are context, not
          identity, and putting the crew first made every unassigned day read as
          a column of "Unassigned". */}
      <span className="font-semibold align-middle truncate">{primary}</span>
      {late && <span className="align-middle ml-1 font-semibold shrink-0">· {late}</span>}
      <span className="align-middle ml-1 opacity-70 truncate">
        {crewName}
        {visit.service_type ? ` · ${visit.service_type}` : ""}
      </span>
    </div>
  );
}

export default function LawnCalendarBoard(props: LawnCalendarBoardProps) {
  const {
    view,
    todayIso,
    visits,
    crews,
    serviceTypes,
    zones,
    rainRiskDates,
    month,
    week,
    day,
    monthViewHref,
    weekViewHref,
    dayViewHref,
    agendaViewHref,
    schedules,
    lawnServices,
    canEdit,
  } = props;
  const toast = useToast();
  const router = useRouter();

  // Inline schedule editor modal — opened by clicking a chip in Month/Week/Day.
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const openSchedule = canEdit ? (id: string) => setEditingScheduleId(id) : undefined;

  // Local optimistic visit state — reset whenever the server hands us a fresh
  // (differently-scoped) visits prop, e.g. after a month/week nav.
  const [localVisits, setLocalVisits] = useState<BoardVisit[]>(visits);
  useEffect(() => {
    // Syncs local optimistic state to fresh server data after a month/week/
    // agenda navigation (the board instance isn't remounted on nav, so
    // without this it would keep showing the previous view's stale visits).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalVisits(visits);
  }, [visits]);

  // Visit peek modal — opened from the Agenda list. Chips in Month/Week/Day
  // keep opening the SCHEDULE editor (they are schedule-level affordances);
  // the agenda rows are the visit-level surface here. Resolved against
  // localVisits (not filteredVisits) so a filter change under an open modal
  // can't blank it out.
  const [peekVisitId, setPeekVisitId] = useState<string | null>(null);
  const closePeek = useCallback(() => setPeekVisitId(null), []);
  const peekVisit = peekVisitId
    ? localVisits.find((v) => v.id === peekVisitId) ?? null
    : null;

  const crewColorIdx = useMemo(() => {
    const map = new Map<string, number>();
    crews.forEach((c, idx) => map.set(c.id, idx % CREW_COLORS.length));
    return map;
  }, [crews]);
  const crewNameById = useMemo(() => {
    const map = new Map<string, string>();
    crews.forEach((c) => map.set(c.id, c.name));
    return map;
  }, [crews]);
  const rainRiskSet = useMemo(() => new Set(rainRiskDates), [rainRiskDates]);

  function colorFor(visit: BoardVisit) {
    if (!visit.crew_id) return UNASSIGNED_COLOR;
    const idx = crewColorIdx.get(visit.crew_id);
    return idx === undefined ? UNASSIGNED_COLOR : CREW_COLORS[idx];
  }
  function nameFor(visit: BoardVisit) {
    return (visit.crew_id && crewNameById.get(visit.crew_id)) || "Unassigned";
  }

  // Filters
  const [crewFilter, setCrewFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<BoardVisit["status"]>>(new Set());
  const [serviceFilter, setServiceFilter] = useState("");
  const [zoneFilter, setZoneFilter] = useState("");
  const [query, setQuery] = useState("");

  // "Apply to future visits too?" banner — shown after a successful
  // crew-reassign drag. Confirming updates the recurring schedule's default
  // crew; dismissing leaves it as a one-off change (today's existing behavior).
  const [applyPrompt, setApplyPrompt] = useState<{
    scheduleId: string;
    crewId: string;
    crewName: string;
    jobName: string;
  } | null>(null);
  const [applyingPrompt, setApplyingPrompt] = useState(false);

  async function applyDefaultCrew() {
    if (!applyPrompt) return;
    setApplyingPrompt(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("recurring_schedules")
        .update({ default_crew_id: applyPrompt.crewId })
        .eq("id", applyPrompt.scheduleId);
      if (error) throw error;
      toast.success(`${applyPrompt.crewName} set as the default crew for future visits`);
    } catch {
      toast.error("Could not update the default crew — try again from the schedule page");
    } finally {
      setApplyingPrompt(false);
      setApplyPrompt(null);
    }
  }

  // Bulk move — Day view only. Reuses the existing /api/lawn/visits/bulk-move
  // endpoint as-is (it already moves every PENDING visit on a date in one
  // request, in place, no new rows). Moves ALL of the day's pending visits
  // org-wide, not just what's currently filtered/visible -- called out in the
  // UI copy so the office isn't surprised by a filtered-out crew's visits
  // moving too.
  const [showMoveDay, setShowMoveDay] = useState(false);
  const [moveDayTarget, setMoveDayTarget] = useState("");
  const [movingDay, setMovingDay] = useState(false);

  async function moveDay(fromDate: string) {
    if (!moveDayTarget) {
      toast.error("Pick a target date");
      return;
    }
    if (moveDayTarget === fromDate) {
      toast.error("Pick a different date");
      return;
    }
    setMovingDay(true);
    try {
      const res = await fetch("/api/lawn/visits/bulk-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate, toDate: moveDayTarget }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? "Could not move the day");
        return;
      }
      const moved = data.moved ?? 0;
      const conflicts = (data.conflicts ?? []) as { jobName: string }[];
      if (conflicts.length > 0) {
        toast.warning(
          `Moved ${moved}, skipped ${conflicts.length} (already a visit on that date for that schedule)`
        );
      } else {
        toast.success(`Moved ${moved} visit${moved === 1 ? "" : "s"}`);
      }
      setShowMoveDay(false);
      setMoveDayTarget("");
      router.refresh();
    } catch {
      toast.error("Could not move the day — try again");
    } finally {
      setMovingDay(false);
    }
  }

  const filteredVisits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return localVisits.filter((v) => {
      if (crewFilter.size > 0) {
        const key = v.crew_id ?? "unassigned";
        if (!crewFilter.has(key)) return false;
      }
      if (statusFilter.size > 0 && !statusFilter.has(v.status)) return false;
      if (serviceFilter && v.service_type !== serviceFilter) return false;
      if (zoneFilter && v.zone_id !== zoneFilter) return false;
      // Search the customer and address too. Searching only job names meant you
      // could not find a property by the name you actually know it by.
      if (
        q &&
        !v.job_name.toLowerCase().includes(q) &&
        !(v.customer_name ?? "").toLowerCase().includes(q) &&
        !(v.address ?? "").toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [localVisits, crewFilter, statusFilter, serviceFilter, zoneFilter, query]);

  // Agenda grouping — computed unconditionally (cheap) so the hook always
  // runs, rather than only when view === "agenda".
  const agendaGroups = useMemo(() => {
    const map = new Map<string, BoardVisit[]>();
    for (const v of filteredVisits) {
      const arr = map.get(v.due_date) ?? [];
      arr.push(v);
      map.set(v.due_date, arr);
    }
    // PAST DUE FIRST, then today onward. Strict chronological order buries the
    // work that actually needs a decision below a month of upcoming visits —
    // and this view previously could not show past dates at all, because the
    // query started at today.
    return Array.from(map.entries()).sort(([a], [b]) => {
      const aPast = a < todayIso;
      const bPast = b < todayIso;
      if (aPast !== bPast) return aPast ? -1 : 1;
      return a.localeCompare(b);
    });
  }, [filteredVisits, todayIso]);

  // DnD sensors — device-aware, matching RouteList.tsx's setup.
  const isCoarse =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } });
  const sensors = useSensors(isCoarse ? touchSensor : pointerSensor);

  async function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over) return;
    const visitId = String(active.id);
    const cellId = String(over.id);
    const visit = localVisits.find((v) => v.id === visitId);
    if (!visit) return;

    let newDate = visit.due_date;
    let newCrew = visit.crew_id;
    if (cellId.includes("::")) {
      const [dateStr, crewPart] = cellId.split("::");
      newDate = dateStr;
      newCrew = crewPart === "unassigned" ? null : crewPart;
    } else {
      newDate = cellId;
    }
    if (newDate === visit.due_date && newCrew === visit.crew_id) return;

    // Soft capacity warning — a heuristic check against the crew's own
    // settings (Scheduling > Crew capacity), not a hard block. Blackout dates
    // and crew time-off aren't checked here (that's server-side, in
    // crew_has_capacity()); this is just enough to stop an accidental
    // overload before it happens, with an easy override for a deliberate one.
    if (newCrew) {
      const crew = crews.find((c) => c.id === newCrew);
      const warnings: string[] = [];
      if (crew?.working_days && crew.working_days.length > 0) {
        const dow1to7 = new Date(newDate + "T00:00:00").getDay() + 1;
        if (!crew.working_days.includes(dow1to7)) {
          warnings.push(`${crew.name} isn't scheduled to work that day.`);
        }
      }
      if (crew?.max_visits_per_day) {
        const countedStatuses = new Set(["pending", "done"]);
        const already = localVisits.filter(
          (v) => v.id !== visitId && v.crew_id === newCrew && v.due_date === newDate && countedStatuses.has(v.status)
        ).length;
        if (already >= crew.max_visits_per_day) {
          warnings.push(
            `${crew.name} already has ${already} visit${already === 1 ? "" : "s"} that day (cap: ${crew.max_visits_per_day}).`
          );
        }
      }
      if (warnings.length > 0 && !confirm(`${warnings.join(" ")}\n\nMove it anyway?`)) {
        return;
      }
    }

    const original = visit;
    setLocalVisits((prev) => prev.map((v) => (v.id === visitId ? { ...v, due_date: newDate, crew_id: newCrew } : v)));

    try {
      if (newDate !== visit.due_date) {
        const res = await fetch(`/api/lawn/visits/${visitId}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ due_date: newDate }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(
            data?.code === "23505"
              ? "A visit already exists on that date for this schedule"
              : data?.error ?? "Could not reschedule"
          );
          setLocalVisits((prev) => prev.map((v) => (v.id === visitId ? original : v)));
        }
      } else if (newCrew !== visit.crew_id) {
        const supabase = createClient();
        const { error } = await supabase
          .from("lawn_visits")
          .update({ crew_id: newCrew, route_order: null })
          .eq("id", visitId);
        if (error) {
          toast.error(error.message);
          setLocalVisits((prev) => prev.map((v) => (v.id === visitId ? original : v)));
        } else if (newCrew) {
          // Offer to make this the schedule's default crew for future visits
          // too (recurring_schedules.default_crew_id) — otherwise every fresh
          // visit the cron generates keeps coming in unassigned regardless of
          // this one-off reassignment.
          const crewName = crews.find((c) => c.id === newCrew)?.name ?? "this crew";
          setApplyPrompt({ scheduleId: visit.recurring_schedule_id, crewId: newCrew, crewName, jobName: visit.job_name });
        }
      }
    } catch {
      toast.error("Could not save — try again");
      setLocalVisits((prev) => prev.map((v) => (v.id === visitId ? original : v)));
    }
  }

  return (
    <div className="space-y-4">
      {/* "Apply to future?" banner after a crew-reassign drag */}
      {applyPrompt && (
        <div className="flex flex-wrap items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
          <p className="text-sm text-blue-900 flex-1 min-w-[220px]">
            Moved <strong>{applyPrompt.jobName}</strong> to <strong>{applyPrompt.crewName}</strong>.
            Also make {applyPrompt.crewName} the default crew for this schedule&rsquo;s future visits?
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={applyDefaultCrew}
              disabled={applyingPrompt}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 active:bg-blue-700 disabled:opacity-50"
            >
              {applyingPrompt ? "Saving…" : "Yes, set default"}
            </button>
            <button
              type="button"
              onClick={() => setApplyPrompt(null)}
              disabled={applyingPrompt}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-900 bg-white border border-blue-200 disabled:opacity-50"
            >
              Just this once
            </button>
          </div>
        </div>
      )}

      {/* View switcher */}
      <div className="flex gap-2">
        <Link
          href={monthViewHref}
          className={`px-4 py-2 rounded-lg text-sm font-semibold ${
            view === "month" ? "bg-brand text-white" : "bg-white text-gray-700 border border-gray-200"
          }`}
        >
          Month
        </Link>
        <Link
          href={weekViewHref}
          className={`px-4 py-2 rounded-lg text-sm font-semibold ${
            view === "week" ? "bg-brand text-white" : "bg-white text-gray-700 border border-gray-200"
          }`}
        >
          Week
        </Link>
        <Link
          href={dayViewHref}
          className={`px-4 py-2 rounded-lg text-sm font-semibold ${
            view === "day" ? "bg-brand text-white" : "bg-white text-gray-700 border border-gray-200"
          }`}
        >
          Day
        </Link>
        <Link
          href={agendaViewHref}
          className={`px-4 py-2 rounded-lg text-sm font-semibold ${
            view === "agenda" ? "bg-brand text-white" : "bg-white text-gray-700 border border-gray-200"
          }`}
        >
          Agenda
        </Link>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={FILTER_PILL}>
          <button type="button" onClick={() => setCrewFilter(new Set())} className={FILTER_BTN(crewFilter.size === 0)}>
            All crews
          </button>
          {crews.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                setCrewFilter((s) => {
                  const next = new Set(s);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  return next;
                })
              }
              className={FILTER_BTN(crewFilter.has(c.id))}
            >
              {c.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() =>
              setCrewFilter((s) => {
                const next = new Set(s);
                if (next.has("unassigned")) next.delete("unassigned");
                else next.add("unassigned");
                return next;
              })
            }
            className={FILTER_BTN(crewFilter.has("unassigned"))}
          >
            Unassigned
          </button>
        </div>

        <div className={FILTER_PILL}>
          <button
            type="button"
            onClick={() => setStatusFilter(new Set())}
            className={FILTER_BTN(statusFilter.size === 0)}
          >
            All
          </button>
          {(["pending", "done", "skipped", "paused"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() =>
                setStatusFilter((set) => {
                  const next = new Set(set);
                  if (next.has(s)) next.delete(s);
                  else next.add(s);
                  return next;
                })
              }
              className={FILTER_BTN(statusFilter.has(s))}
            >
              {s}
            </button>
          ))}
        </div>

        <select
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        >
          <option value="">All services</option>
          {serviceTypes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {zones.length > 0 && (
          <select
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">All zones</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        )}

        <div className="relative max-w-xs">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search job name…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
        </div>
      </div>

      {/* Month view */}
      {view === "month" && month && (
        <>
          <div className="flex items-center justify-between">
            <Link href={month.prevHref} className="p-2 -ml-2 text-gray-600 active:text-gray-900" aria-label="Previous month">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div className="text-center">
              <p className="text-base font-bold text-gray-900">{month.monthLabel}</p>
              {!month.isCurrentMonth && (
                <Link href={month.todayHref} className="text-xs text-blue-600 font-medium">
                  Today
                </Link>
              )}
            </div>
            <Link href={month.nextHref} className="p-2 -mr-2 text-gray-600 active:text-gray-900" aria-label="Next month">
              <ChevronRight className="w-5 h-5" />
            </Link>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="text-center text-[10px] font-semibold text-gray-400 uppercase">
                {d}
              </div>
            ))}
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div className="grid grid-cols-7 gap-1">
              {month.cells.map((dateStr, i) => {
                if (dateStr === null) return <div key={`b-${i}`} className="min-h-[64px] lg:min-h-[110px]" />;
                const dayVisits = filteredVisits.filter((v) => v.due_date === dateStr);
                const isToday = dateStr === todayIso;
                const shown = dayVisits.slice(0, MAX_CHIPS_PER_CELL_DESKTOP);
                const mobileExtra = dayVisits.length - Math.min(dayVisits.length, MAX_CHIPS_PER_CELL);
                const desktopExtra = dayVisits.length - shown.length;
                return (
                  <DroppableCell
                    key={dateStr}
                    id={dateStr}
                    className={`min-h-[64px] lg:min-h-[110px] rounded-lg p-1 lg:p-1.5 flex flex-col gap-1 ${
                      isToday ? "bg-blue-50 ring-1 ring-blue-300" : "bg-white"
                    }`}
                  >
                    <span className="flex items-center justify-end gap-1 self-end leading-none">
                      {rainRiskSet.has(dateStr) && (
                        <CloudRain className="w-2.5 h-2.5 text-blue-400" aria-label="Rain risk" />
                      )}
                      <span
                        className={`text-[10px] lg:text-xs font-semibold ${
                          isToday ? "text-blue-700" : "text-gray-400"
                        }`}
                      >
                        {Number(dateStr.slice(-2))}
                      </span>
                    </span>
                    {shown.map((v, idx) => (
                      <DraggableChip
                        today={todayIso}
                        key={v.id}
                        visit={v}
                        crewName={nameFor(v)}
                        color={colorFor(v)}
                        extraClassName={idx >= MAX_CHIPS_PER_CELL ? "hidden lg:block" : ""}
                        onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                      />
                    ))}
                    {mobileExtra > 0 && <span className="text-[9px] text-gray-400 px-1 lg:hidden">+{mobileExtra} more</span>}
                    {desktopExtra > 0 && (
                      <span className="hidden lg:block text-[9px] text-gray-400 px-1">+{desktopExtra} more</span>
                    )}
                  </DroppableCell>
                );
              })}
            </div>
          </DndContext>
        </>
      )}

      {/* Week view */}
      {view === "week" && week && (
        <>
          <div className="flex items-center justify-between">
            <Link href={week.prevHref} className="p-2 -ml-2 text-gray-600 active:text-gray-900" aria-label="Previous week">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div className="text-center">
              <p className="text-base font-bold text-gray-900">
                {new Date(week.days[0] + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                {" – "}
                {new Date(week.days[6] + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </p>
              <Link href={week.todayHref} className="text-xs text-blue-600 font-medium">
                Today
              </Link>
            </div>
            <Link href={week.nextHref} className="p-2 -mr-2 text-gray-600 active:text-gray-900" aria-label="Next week">
              <ChevronRight className="w-5 h-5" />
            </Link>
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            {/* Phone (< lg): the week as a vertical list of day rows. Seven
                columns on a 375px screen are ~45px per cell — too narrow for a
                customer name no matter how the cell is styled — so portrait
                phones get a deliberate list layout instead of the matrix.
                Full width is the feature: no indentation, no side-by-side.
                Pure CSS breakpoint (lg:hidden / hidden lg:block), no JS
                viewport check. */}
            <div className="lg:hidden space-y-2">
              {week.days.map((d) => {
                const dayVisits = filteredVisits
                  .filter((v) => v.due_date === d)
                  // Same window-start sort (nulls last) as Day view.
                  .sort((a, b) => {
                    const at = a.scheduled_window_start ?? "";
                    const bt = b.scheduled_window_start ?? "";
                    if (!at && !bt) return 0;
                    if (!at) return 1;
                    if (!bt) return -1;
                    return at.localeCompare(bt);
                  });
                const isToday = d === todayIso;
                return (
                  <DroppableCell
                    key={d}
                    // Bare date id (no ::crew) — handleDragEnd treats an id
                    // without "::" as date-only, so a drop onto a day row
                    // reschedules the visit and keeps whoever was assigned.
                    id={d}
                    className={`min-h-[44px] rounded-lg p-2 flex flex-col gap-1.5 ${
                      isToday ? "bg-blue-50 ring-1 ring-blue-300" : "bg-white"
                    }`}
                  >
                    {/* Plain header, not a link/button — the row header must
                        not compete with the chips for taps or keyboard focus. */}
                    <div className="flex items-center gap-1.5 leading-none">
                      <span className={`text-xs font-semibold ${isToday ? "text-blue-700" : "text-gray-500"}`}>
                        {new Date(d + "T00:00:00").toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "numeric",
                          day: "numeric",
                        })}
                      </span>
                      {rainRiskSet.has(d) && <CloudRain className="w-3 h-3 text-blue-400" aria-label="Rain risk" />}
                      <span className="ml-auto text-[10px] font-medium text-gray-400">
                        {dayVisits.length} visit{dayVisits.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {dayVisits.length === 0 ? (
                      // Kept in the flow rather than collapsed — an empty day
                      // is still a valid drop target for rescheduling.
                      <span className="text-xs text-gray-300 py-0.5">No visits</span>
                    ) : (
                      dayVisits.map((v) => (
                        <DraggableChip
                          today={todayIso}
                          key={v.id}
                          visit={v}
                          crewName={nameFor(v)}
                          color={colorFor(v)}
                          extraClassName="w-full"
                          onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                        />
                      ))
                    )}
                  </DroppableCell>
                );
              })}
            </div>

            {/* lg+: the crew × day matrix. Unchanged except `hidden lg:block`
                on its scroll wrapper, which hides it below lg in favour of the
                day list above. */}
            <div className="overflow-x-auto hidden lg:block">
              <div className="min-w-[900px]">
                <div className="grid grid-cols-[140px_repeat(7,1fr)] gap-1">
                  <div />
                  {week.days.map((d) => (
                    <div
                      key={d}
                      className="flex items-center justify-center gap-1 text-center text-[10px] font-semibold text-gray-400 uppercase py-1"
                    >
                      {rainRiskSet.has(d) && (
                        <CloudRain className="w-2.5 h-2.5 text-blue-400" aria-label="Rain risk" />
                      )}
                      {new Date(d + "T00:00:00").toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "numeric",
                        day: "numeric",
                      })}
                    </div>
                  ))}
                </div>
                {[...crews, { id: "unassigned", name: "Unassigned" }].map((c) => (
                  <div key={c.id} className="grid grid-cols-[140px_repeat(7,1fr)] gap-1 items-start border-t border-gray-100">
                    <div className="text-sm font-medium text-gray-700 py-2 truncate">{c.name}</div>
                    {week.days.map((d) => {
                      const cellVisits = filteredVisits.filter(
                        (v) => v.due_date === d && (c.id === "unassigned" ? !v.crew_id : v.crew_id === c.id)
                      );
                      return (
                        <DroppableCell key={d} id={`${d}::${c.id}`} className="min-h-[52px] p-1 flex flex-col gap-1">
                          {cellVisits.map((v) => (
                            <DraggableChip
                        today={todayIso}
                              key={v.id}
                              visit={v}
                              crewName={nameFor(v)}
                              color={colorFor(v)}
                              onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                            />
                          ))}
                        </DroppableCell>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </DndContext>
        </>
      )}

      {/* Day view — one crew per row (+ Unassigned), visits within a row
          sorted by scheduled window start (unset windows sort last and show
          no time). Reuses the exact same `${date}::${crewId}` cell-id
          convention as Week view, so handleDragEnd needs no Day-specific
          branch -- dragging within the day just reassigns crew like Week's
          same-day drag already does. */}
      {view === "day" && day && (
        <>
          <div className="flex items-center justify-between">
            <Link href={day.prevHref} className="p-2 -ml-2 text-gray-600 active:text-gray-900" aria-label="Previous day">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div className="text-center">
              <p className="text-base font-bold text-gray-900 flex items-center justify-center gap-1.5">
                {day.label}
                {rainRiskSet.has(day.date) && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-600" title="Rain risk">
                    <CloudRain className="w-3.5 h-3.5" />
                    Rain risk
                  </span>
                )}
              </p>
              {!day.isToday && (
                <Link href={day.todayHref} className="text-xs text-blue-600 font-medium">
                  Today
                </Link>
              )}
            </div>
            <Link href={day.nextHref} className="p-2 -mr-2 text-gray-600 active:text-gray-900" aria-label="Next day">
              <ChevronRight className="w-5 h-5" />
            </Link>
          </div>

          <div>
            {!showMoveDay ? (
              <button
                type="button"
                onClick={() => setShowMoveDay(true)}
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                Move all of this day&rsquo;s visits…
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg p-2">
                <span className="text-xs text-blue-900">
                  Move every <strong>pending</strong> visit on {day.label} (org-wide — not just what&rsquo;s filtered/shown) to:
                </span>
                <input
                  type="date"
                  value={moveDayTarget}
                  onChange={(e) => setMoveDayTarget(e.target.value)}
                  className="border border-gray-300 rounded-lg px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => moveDay(day.date)}
                  disabled={movingDay}
                  className="px-3 py-1 rounded-lg text-xs font-semibold text-white bg-blue-600 active:bg-blue-700 disabled:opacity-50"
                >
                  {movingDay ? "Moving…" : "Move"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowMoveDay(false);
                    setMoveDayTarget("");
                  }}
                  disabled={movingDay}
                  className="px-3 py-1 rounded-lg text-xs font-semibold text-blue-900 bg-white border border-blue-200 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white overflow-hidden">
              {[...crews, { id: "unassigned", name: "Unassigned" }].map((c) => {
                const rowVisits = filteredVisits
                  .filter((v) => v.due_date === day.date && (c.id === "unassigned" ? !v.crew_id : v.crew_id === c.id))
                  .sort((a, b) => {
                    const at = a.scheduled_window_start ?? "";
                    const bt = b.scheduled_window_start ?? "";
                    if (!at && !bt) return 0;
                    if (!at) return 1;
                    if (!bt) return -1;
                    return at.localeCompare(bt);
                  });
                return (
                  <div key={c.id} className="flex items-start gap-3 p-2">
                    <div className="w-28 shrink-0 text-sm font-medium text-gray-700 pt-1">{c.name}</div>
                    <DroppableCell id={`${day.date}::${c.id}`} className="flex-1 min-h-[44px] flex flex-wrap gap-1.5 p-1 rounded">
                      {rowVisits.length === 0 && <span className="text-xs text-gray-300 py-1">No visits</span>}
                      {rowVisits.map((v) => (
                        <DraggableChip
                        today={todayIso}
                          key={v.id}
                          visit={v}
                          crewName={nameFor(v)}
                          color={colorFor(v)}
                          showTime
                          onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                        />
                      ))}
                    </DroppableCell>
                  </div>
                );
              })}
            </div>
          </DndContext>
        </>
      )}

      {/* Agenda view — no drag-and-drop, plain clickable list */}
      {view === "agenda" &&
        (agendaGroups.length === 0 ? (
          <div className="text-center py-10">
            <CalendarDays className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">Nothing scheduled or overdue</p>
            <p className="text-xs text-gray-500 mt-1">
              Past-due visits and anything due in the next 30 days appear here.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
            {agendaGroups.map(([dateStr, dayVisits]) => {
              const tomorrowIso = (() => {
                const d = new Date(todayIso + "T00:00:00");
                d.setDate(d.getDate() + 1);
                return d.toISOString().slice(0, 10);
              })();
              const isPastDue = dateStr < todayIso;
              const label =
                dateStr === todayIso
                  ? "Today"
                  : dateStr === tomorrowIso
                  ? "Tomorrow"
                  : new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    });
              return (
                <div key={dateStr}>
                  <div
                    className={`px-3 py-2 sticky top-0 ${
                      isPastDue ? "bg-orange-50 border-y border-orange-200" : "bg-gray-50"
                    }`}
                  >
                    <p
                      className={`text-xs font-semibold uppercase tracking-wide ${
                        isPastDue ? "text-orange-800" : "text-gray-500"
                      }`}
                    >
                      {label}
                      {isPastDue && (
                        <span className="normal-case font-normal">
                          {" "}· past due, {lateLabel(dateStr, todayIso)}
                        </span>
                      )}
                    </p>
                  </div>
                  {dayVisits.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      // Peek, don't navigate — the row's data is already in the
                      // board's memory. The full visit page stays reachable from
                      // inside the modal for editing.
                      onClick={() => setPeekVisitId(v.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left active:bg-gray-50 hover:bg-gray-50"
                    >
                      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${colorFor(v).dot}`} />
                      <span className="text-sm text-gray-900 truncate flex-1 min-w-0">
                        {v.customer_name ?? v.job_name}
                        {v.customer_name && (
                          <span className="text-gray-400"> · {v.job_name}</span>
                        )}
                      </span>
                      {v.service_type && <span className="text-xs text-gray-400 shrink-0">{v.service_type}</span>}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize shrink-0 ${STATUS_BADGE[v.status]}`}>
                        {v.status}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ))}

      {/* Crew & Jobs legend — Month and Week views only */}
      {(view === "month" || view === "week" || view === "day") && (
        <section className="space-y-2 pt-2">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide">Crew &amp; Jobs</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {crews.map((c) => {
              const count = filteredVisits.filter((v) => v.crew_id === c.id).length;
              const color = CREW_COLORS[crewColorIdx.get(c.id) ?? 0];
              return (
                <div key={c.id} className="bg-white rounded-lg p-3 shadow-sm flex items-center gap-2">
                  <span className={`inline-block w-3 h-3 rounded-full ${color.dot}`} />
                  <span className="font-semibold text-gray-900 text-sm truncate flex-1">{c.name}</span>
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {count} visit{count === 1 ? "" : "s"}
                  </span>
                </div>
              );
            })}
            {(() => {
              const count = filteredVisits.filter((v) => !v.crew_id).length;
              return (
                <div className="bg-white rounded-lg p-3 shadow-sm flex items-center gap-2">
                  <span className={`inline-block w-3 h-3 rounded-full ${UNASSIGNED_COLOR.dot}`} />
                  <span className="font-semibold text-gray-900 text-sm truncate flex-1">Unassigned</span>
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {count} visit{count === 1 ? "" : "s"}
                  </span>
                </div>
              );
            })()}
          </div>
        </section>
      )}

      {/* Visit peek modal — Agenda rows only. Rendered outside the view
          conditionals so it survives an open modal across a re-render. */}
      {peekVisit && (
        <VisitPeekModal
          visit={toPeekVisit(peekVisit, nameFor(peekVisit))}
          today={todayIso}
          from="calendar"
          onClose={closePeek}
        />
      )}

      {/* Inline schedule editor modal — item #8. Opened by clicking a chip in
          Month/Week/Day; Agenda rows stay plain navigation links. */}
      {editingScheduleId && schedules[editingScheduleId] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEditingScheduleId(null)}
        >
          <div
            className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setEditingScheduleId(null)}
              className="absolute top-3 right-3 z-10 p-1 rounded-full bg-white text-gray-400 hover:text-gray-600 shadow-sm"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
            <RecurringScheduleEditor
              scheduleId={editingScheduleId}
              initial={schedules[editingScheduleId]}
              lawnServices={lawnServices}
              canEdit={canEdit}
              initialEditing
              onSaved={(patch) => {
                const scheduleId = editingScheduleId;
                setLocalVisits((prev) =>
                  prev.map((v) =>
                    v.recurring_schedule_id === scheduleId
                      ? { ...v, service_type: patch.service_type }
                      : v
                  )
                );
                setEditingScheduleId(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
