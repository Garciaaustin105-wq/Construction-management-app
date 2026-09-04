"use client";

import { useMemo, useState, useEffect, useCallback, useRef, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDndContext,
  type CollisionDetection,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
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
  // Previously-saved per-crew route position (null = never explicitly
  // ordered). The week view's phone day rows sort on it before the window.
  route_order: number | null;
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

// Below lg a month cell is navigation, not a working view: it renders one
// dot per visit up to this cap (plus a "+N"), and the whole cell links to that
// DAY. It pointed at the week first, on the reasoning that the week carries the
// phone working layout — but tapping a specific day and landing on a whole week
// is not what the tap promises. The day view is a vertical crew list, so it
// reads fine on a phone; the week is one tap further if that is what you wanted.
const MAX_DOTS_PER_MOBILE_CELL = 3;
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

// A phone week-view day row's visible order: the saved route sequence first
// (route_order, nulls last), then the scheduled window (nulls last) for
// anything never explicitly ordered. Replaces the window-only sort the day
// rows used — the saved sequence becomes the visible order.
function byRouteThenWindow(a: BoardVisit, b: BoardVisit): number {
  const ao = a.route_order ?? null;
  const bo = b.route_order ?? null;
  if (ao !== null && bo !== null) {
    if (ao !== bo) return ao - bo;
  } else if (ao !== null) {
    return -1;
  } else if (bo !== null) {
    return 1;
  }
  const at = a.scheduled_window_start ?? "";
  const bt = b.scheduled_window_start ?? "";
  if (!at && !bt) return 0;
  if (!at) return 1;
  if (!bt) return -1;
  return at.localeCompare(bt);
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

// The visual chip body, shared by DraggableChip (month / week matrix / day)
// and SortableDayChip (phone week rows). "compact" is the original sizing;
// "comfortable" is the phone day-row sizing — full-width, ~44px touch height,
// honest padding. The drag hook lives in the caller; the face just renders.
function VisitChipFace({
  variant,
  visit,
  crewName,
  today,
  color,
  extraClassName,
  showTime,
  onClick,
  setNodeRef,
  transform,
  isDragging,
  attributes,
  listeners,
}: {
  variant: "compact" | "comfortable";
  visit: BoardVisit;
  crewName: string;
  /** The organisation's today, so "late" means late where the work happens. */
  today: string;
  color: { dot: string; chip: string };
  extraClassName?: string;
  // Day view / phone rows — prefixes the chip with its scheduled window, if set.
  showTime?: boolean;
  // Opens the schedule editor modal. A plain click (no drag movement) still
  // fires this — dnd-kit's PointerSensor only starts a drag past its 6px
  // activation distance, so a tap-and-release passes through as a click.
  onClick?: () => void;
  setNodeRef?: (node: HTMLElement | null) => void;
  transform?: Transform | null;
  isDragging?: boolean;
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
}) {
  const comfortable = variant === "comfortable";
  // touch-pan-y on the phone chips: with the default touch-action the browser
  // claims a held touch the moment it drifts (scroll intent), fires
  // touchcancel, and dnd-kit's TouchSensor hold timer dies — press-and-hold
  // then feels like a coin flip. pan-y keeps vertical scrolling working (a
  // swipe on the list still scrolls) while a small drift during the hold no
  // longer aborts the drag.
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
      className={`${
        comfortable
          ? "flex items-center gap-2 rounded-lg px-2.5 py-2 min-h-[44px] text-xs leading-snug truncate cursor-grab active:cursor-grabbing touch-pan-y"
          : "flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate cursor-grab active:cursor-grabbing touch-pan-y"
      } ${
        skipped
          ? "bg-red-50 text-red-700 border border-red-200 line-through"
          : overdue
            ? "bg-orange-100 text-orange-900 border border-orange-300 font-medium"
            : color.chip
      } ${isDragging ? "opacity-60" : ""} ${extraClassName ?? ""}`}
    >
      {skipped ? (
        <AlertTriangle className={comfortable ? "inline-block w-3.5 h-3.5 mr-1 align-middle shrink-0" : "inline-block w-2.5 h-2.5 mr-1 align-middle shrink-0"} />
      ) : overdue ? (
        <AlertTriangle className={comfortable ? "inline-block w-3.5 h-3.5 mr-1 align-middle shrink-0 text-orange-600" : "inline-block w-2.5 h-2.5 mr-1 align-middle shrink-0 text-orange-600"} />
      ) : (
        <span className={`inline-block ${comfortable ? "w-2 h-2" : "w-1.5 h-1.5"} rounded-full mr-1 align-middle ${color.dot}`} />
      )}
      {timeLabel && (
        <span className={`font-mono text-gray-500 align-middle mr-1 ${comfortable ? "text-[10px]" : "text-[9px]"}`}>
          {timeLabel}
        </span>
      )}
      {/* Customer leads. Crew and service follow, muted — they are context, not
          identity, and putting the crew first made every unassigned day read as
          a column of "Unassigned". */}
      <span className={`font-semibold align-middle truncate ${comfortable ? "text-sm" : ""}`}>{primary}</span>
      {late && <span className="align-middle ml-1 font-semibold shrink-0">· {late}</span>}
      <span className={`align-middle opacity-70 truncate ${comfortable ? "ml-auto pl-1 text-[11px]" : "ml-1"}`}>
        {crewName}
        {visit.service_type ? ` · ${visit.service_type}` : ""}
      </span>
    </div>
  );
}

// A draggable visit chip. One useDraggable call per mounted chip, at this
// component's own top level — same reasoning as DroppableCell above.
function DraggableChip(props: {
  visit: BoardVisit;
  crewName: string;
  today: string;
  color: { dot: string; chip: string };
  extraClassName?: string;
  showTime?: boolean;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: props.visit.id });
  return <VisitChipFace variant="compact" {...props} attributes={attributes} listeners={listeners} setNodeRef={setNodeRef} transform={transform} isDragging={isDragging} />;
}

// The sortable chip variant — phone week-view day rows only. useSortable (not
// useDraggable) is what makes a drag reorder the row via SortableContext: the
// neighbouring chips shift to open a real gap at the insertion point, and a
// drop lands the visit at that position. Month, week-matrix and day chips keep
// the plain useDraggable behaviour above.
function SortableDayChip({
  visit,
  crewName,
  today,
  color,
  onClick,
}: {
  visit: BoardVisit;
  crewName: string;
  today: string;
  color: { dot: string; chip: string };
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id: visit.id });
  return (
    <VisitChipFace
      variant="comfortable"
      visit={visit}
      crewName={crewName}
      today={today}
      color={color}
      extraClassName="w-full"
      onClick={onClick}
      attributes={attributes}
      listeners={listeners}
      setNodeRef={setNodeRef}
      transform={transform}
      isDragging={isDragging}
    />
  );
}

// One phone day row in the week view. Its own droppable (bare-date id, the
// convention handleDragEnd expects) rather than DroppableCell, because the
// drop highlight needs to cover the row's chips too: sortable chips register
// as droppables of their own and would otherwise steal the highlight from the
// row they sit in. Blue is reserved for the transient drag-over state
// (bg-blue-200 + dashed outline) — today wears NEUTRAL grey instead. Both
// used to be blue, and the permanent blue wash read as a stuck drop target
// (reported as a bug). The principle: state is blue and temporary; identity
// is not blue. Desktop and the month view keep their existing today styling.
function MobileDayRow({
  id,
  isToday,
  visitDateById,
  className,
  children,
}: {
  id: string;
  isToday: boolean;
  visitDateById: Map<string, string>;
  className: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { over } = useDndContext();
  const overId = over ? String(over.id) : null;
  const isDragOver = isOver || (overId !== null && visitDateById.get(overId) === id);
  return (
    <div
      ref={setNodeRef}
      className={`${className} ${
        isDragOver
          ? "bg-blue-200 outline-2 outline-dashed outline-blue-500"
          : isToday
            ? "bg-gray-100 ring-1 ring-gray-300"
            : "bg-white"
      }`}
    >
      {children}
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

  // The visit being carried by the phone day-row DragOverlay (below). Tracked
  // at the day-row DndContext level — set on drag start, cleared on end or
  // cancel — so the overlay renders a real chip face that follows the pointer.
  const [activeDayChipId, setActiveDayChipId] = useState<string | null>(null);
  const activeDayChip = activeDayChipId
    ? (localVisits.find((v) => v.id === activeDayChipId) ?? null)
    : null;

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

  // Visit id -> due date, for the phone day rows' drop highlight: a sortable
  // chip registers as its own droppable, so "is the row the target?" has to
  // resolve chip ids back to their day.
  const visitDateById = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of filteredVisits) map.set(v.id, v.due_date);
    return map;
  }, [filteredVisits]);

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

  // DnD sensors — run BOTH, never pick one. PointerSensor-style single-sensor
  // choice by media query cannot work on a touchscreen laptop: its PRIMARY
  // pointer is fine, but any-pointer: coarse is true for ANY touch input, so
  // one-at-a-time always strands one of its two pointers. MouseSensor binds
  // mousedown only and TouchSensor binds touchstart only — disjoint event
  // types, no conflict — so a hybrid device simply gets whichever gesture it
  // makes. Mouse keeps the instant 6px grab (a plain tap still opens the
  // editor); touch keeps hold-to-drag.
  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 6 } });
  // Touch hold: an 8px tolerance during the hold demanded a fingertip sit
  // almost perfectly still — ordinary tremor blew past it and the press turned
  // into a scroll instead ("finicky with pressing and holding"). 25px still
  // excludes a fast scroll (a swipe travels far more than 25px) but forgives a
  // resting finger's drift. At a 200ms delay a SLOW scroll start (finger eases
  // down <25px inside the hold window) still activated the drag and the chip
  // then followed the scrolling finger — so the hold is now 400ms (iOS
  // long-press territory): any real scroll gesture exceeds 25px well inside
  // 400ms, while a deliberate press-and-hold to move a visit stays comfortable.
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 25 } });
  const sensors = useSensors(mouseSensor, touchSensor);

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

  // Phone week-view day-row reorder: staged route_order writes. Mirrors
  // RouteMapPlanner's auto-save — each reorder walks the day row's new visual
  // order and assigns per-crew 1..n counters keyed by crew_id (moving a visit
  // past another crew's visit leaves both crews' sequences intact); a visit
  // with no crew gets null. The walk happens on drop; the write is debounced
  // ~800ms and the effect skips mount, so the initial render never persists an
  // order nobody asked for. Plain lawn_visits updates in Promise.all, no
  // router.refresh() — local state is the truth and a refresh mid-drag is
  // jarring. crew_id is never written from this surface
  // (guard_lawn_visit_crew_update restricts it, and crew assignment on a phone
  // is out of scope here).
  const [routeDrafts, setRouteDrafts] = useState<
    Record<string, { id: string; route_order: number | null }[]>
  >({});
  const routeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeSavesMounted = useRef(false);
  useEffect(() => {
    if (!routeSavesMounted.current) {
      routeSavesMounted.current = true;
      return;
    }
    if (routeSaveTimer.current) clearTimeout(routeSaveTimer.current);
    routeSaveTimer.current = setTimeout(() => {
      void (async () => {
        // A visit reordered and then immediately dragged to another day gets
        // route_order nulled by the reschedule endpoint; pin each write to the
        // day it was staged for so a follow-up move can't resurrect an order.
        const supabase = createClient();
        const targets: { id: string; route_order: number | null; date: string }[] = [];
        for (const [date, items] of Object.entries(routeDrafts)) {
          for (const item of items) targets.push({ ...item, date });
        }
        if (targets.length === 0) return;
        const results = await Promise.all(
          targets.map((t) =>
            supabase
              .from("lawn_visits")
              .update({ route_order: t.route_order })
              .eq("id", t.id)
              .eq("due_date", t.date)
          )
        );
        if (results.some((r) => r.error)) {
          toast.error("Could not save the new order — try again");
        }
      })();
    }, 800);
    return () => {
      if (routeSaveTimer.current) clearTimeout(routeSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDrafts]);

  // Optimistically applies a day row's new sequence and stages its per-crew
  // route_order for the debounced write above.
  function commitRowOrder(date: string, next: BoardVisit[]) {
    const counters = new Map<string, number>();
    const staged = next.map((v) => {
      if (!v.crew_id) return { id: v.id, route_order: null };
      const n = (counters.get(v.crew_id) ?? 0) + 1;
      counters.set(v.crew_id, n);
      return { id: v.id, route_order: n };
    });
    const orderById = new Map(staged.map((s) => [s.id, s.route_order]));
    setLocalVisits((prev) =>
      prev.map((v) => (orderById.has(v.id) ? { ...v, route_order: orderById.get(v.id) ?? null } : v))
    );
    setRouteDrafts((prev) => ({ ...prev, [date]: staged }));
  }

  // Reorders one day row: `overId` chip → land at that chip's position; null
  // → dropped on the row's empty space → last position.
  function reorderDayRow(date: string, activeId: string, overId: string | null) {
    const dayList = localVisits
      .filter((v) => v.due_date === date)
      .sort(byRouteThenWindow);
    const from = dayList.findIndex((v) => v.id === activeId);
    if (from === -1) return;
    let next: BoardVisit[];
    if (overId === null) {
      next = [...dayList.filter((v) => v.id !== activeId), dayList[from]];
    } else {
      const to = dayList.findIndex((v) => v.id === overId);
      if (to === -1 || to === from) return;
      next = arrayMove(dayList, from, to);
    }
    commitRowOrder(date, next);
  }

  // Phone day rows' drag end. Same-day chip drops reorder the row; everything
  // else — including a drop on another day's chip or on its empty space — is a
  // cross-day reschedule through the untouched shared handleDragEnd via the
  // bare-date id convention (a chip maps to that chip's day; the crew is
  // unchanged, so its capacity confirms can't fire).
  // Phone day rows drop where the FINGER is, not where the chip's centre is.
  //
  // closestCenter measures the dragged element's centre against each row's
  // centre. Day rows are tall, so the chip had to travel most of the way into
  // the target before it won — the user had to "drag my finger about 2 inches
  // below the day" to drop on it. pointerWithin resolves against the pointer
  // instead, so the row under your fingertip is the row you get.
  //
  // rectIntersection is the fallback for the moment the pointer is outside
  // every row (between rows, or past the last one) — pointerWithin returns
  // nothing there, and with no fallback the drop would be silently cancelled.
  //
  // Scoped to this DndContext on purpose. Month, the week matrix and day view
  // keep closestCenter: they are mouse-first grids where it behaves well, and
  // changing them would risk a regression for no reported problem.
  const dayRowCollision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    return hits.length > 0 ? hits : rectIntersection(args);
  };

  function handleDayRowDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over) return;
    const visitId = String(active.id);
    const overId = String(over.id);
    const visit = localVisits.find((v) => v.id === visitId);
    if (!visit) return;
    const overVisit = localVisits.find((v) => v.id === overId);

    if (overVisit && overVisit.id !== visitId && overVisit.due_date === visit.due_date) {
      reorderDayRow(visit.due_date, visitId, overId);
      return;
    }
    if (!overVisit && overId === visit.due_date) {
      // Own row's empty space → last in the row.
      reorderDayRow(visit.due_date, visitId, null);
      return;
    }

    const targetDate = overVisit ? overVisit.due_date : overId;
    if (week && !week.days.includes(targetDate)) return;
    if (overVisit) {
      // The reschedule endpoint nulls route_order on a date change — mirror
      // that locally so the visit joins the target day's unsorted tail.
      setLocalVisits((prev) => prev.map((v) => (v.id === visitId ? { ...v, route_order: null } : v)));
    }
    handleDragEnd({ ...e, over: { ...over, id: targetDate } });
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
                const desktopExtra = dayVisits.length - shown.length;
                const dots = dayVisits.slice(0, MAX_DOTS_PER_MOBILE_CELL);
                const mobileExtra = dayVisits.length - dots.length;
                // The accessible name is the date plus the visit count — this
                // is a navigation control now, not a day's contents.
                const cellLabel = new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                });
                return (
                  <DroppableCell
                    key={dateStr}
                    id={dateStr}
                    /* p-0 below lg: the phone link below fills the whole cell
                       (its own p-1.5 keeps the original inset), so the tap
                       target is the entire cell. lg restores the working inset. */
                    className={`min-h-[64px] lg:min-h-[110px] rounded-lg p-0 lg:p-1.5 flex flex-col ${
                      isToday ? "bg-blue-50 ring-1 ring-blue-300" : "bg-white"
                    }`}
                  >
                    {/* Phone (< lg): navigation only. ~45px of width cannot
                        carry a customer name, so no chips and nothing to drag —
                        the week view's day rows are the phone working view.
                        Up to 3 dots (one per visit, crew-coloured) say WHICH
                        days have work; the whole cell links to that week. */}
                    <Link
                      href={`/lawn/calendar?view=day&date=${dateStr}`}
                      aria-label={`${cellLabel}${
                        dayVisits.length
                          ? `, ${dayVisits.length} visit${dayVisits.length === 1 ? "" : "s"}`
                          : ", no visits"
                      }${rainRiskSet.has(dateStr) ? ", rain risk" : ""}`}
                      className="lg:hidden flex-1 flex flex-col justify-between gap-1.5 p-1.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40 active:bg-blue-100"
                    >
                      <span className="flex items-center justify-between leading-none">
                        {rainRiskSet.has(dateStr) && (
                          <CloudRain className="w-3 h-3 text-blue-400" aria-hidden="true" />
                        )}
                        <span
                          className={`text-xs font-semibold ${
                            isToday ? "text-blue-700" : "text-gray-500"
                          }`}
                        >
                          {Number(dateStr.slice(-2))}
                        </span>
                      </span>
                      {dayVisits.length > 0 && (
                        <span className="flex items-center gap-1 leading-none">
                          {dots.map((v) => (
                            <span
                              key={v.id}
                              className={`inline-block w-1.5 h-1.5 rounded-full ${colorFor(v).dot}`}
                            />
                          ))}
                          {mobileExtra > 0 && (
                            <span className="text-[9px] font-medium text-gray-400">+{mobileExtra}</span>
                          )}
                        </span>
                      )}
                    </Link>
                    {/* Desktop (lg+): the working month — chips, drag, +N more.
                        Unchanged from the pre-navigation layout. */}
                    <div className="hidden lg:flex flex-col gap-1">
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
                      {shown.map((v) => (
                        <DraggableChip
                          today={todayIso}
                          key={v.id}
                          visit={v}
                          crewName={nameFor(v)}
                          color={colorFor(v)}
                          onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                        />
                      ))}
                      {desktopExtra > 0 && (
                        <span className="text-[9px] text-gray-400 px-1">+{desktopExtra} more</span>
                      )}
                    </div>
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

          {/* Phone (< lg): the week as a vertical list of day rows. Seven
                columns on a 375px screen are ~45px per cell — too narrow for a
                customer name no matter how the cell is styled — so portrait
                phones get a deliberate list layout instead of the matrix.
                Full width is the feature: no indentation, no side-by-side.
                Pure CSS breakpoint (lg:hidden / hidden lg:block), no JS
                viewport check.

                Own DndContext: the chips are @dnd-kit/sortable items, so
                holding and dragging within a row reorders it — the
                neighbouring chips shift to open a real gap at the insertion
                point, and the drop persists per-crew route_order. Cross-day
                drops (another day's row or chip) go through
                handleDayRowDragEnd to the untouched shared handleDragEnd via
                the bare-date id convention. */}
          <div className="lg:hidden">
            <DndContext
              sensors={sensors}
              collisionDetection={dayRowCollision}
              onDragStart={(e) => setActiveDayChipId(String(e.active.id))}
              onDragEnd={(e) => {
                setActiveDayChipId(null);
                handleDayRowDragEnd(e);
              }}
              onDragCancel={() => setActiveDayChipId(null)}
            >
              <div className="space-y-2">
                {week.days.map((d) => {
                  const dayVisits = filteredVisits
                    .filter((v) => v.due_date === d)
                    .sort(byRouteThenWindow);
                  const isToday = d === todayIso;
                  return (
                    <MobileDayRow
                      key={d}
                      id={d}
                      isToday={isToday}
                      visitDateById={visitDateById}
                      className="min-h-[56px] rounded-lg p-3 flex flex-col gap-2"
                    >
                      {/* Plain header, not a link/button — the row header must
                          not compete with the chips for taps or keyboard focus. */}
                      <div className="flex items-center gap-1.5 leading-none">
                        <span className={`text-xs font-semibold ${isToday ? "text-gray-900" : "text-gray-500"}`}>
                          {new Date(d + "T00:00:00").toLocaleDateString(undefined, {
                            weekday: "short",
                            month: "numeric",
                            day: "numeric",
                          })}
                        </span>
                        {/* Identity, not state: the pill says "today", the row's
                            neutral grey says it is not a drop target. */}
                        {isToday && (
                          <span className="rounded-full bg-gray-900 text-white text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5">
                            Today
                          </span>
                        )}
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
                        <SortableContext
                          items={dayVisits.map((v) => v.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          {dayVisits.map((v) => (
                            <SortableDayChip
                              today={todayIso}
                              key={v.id}
                              visit={v}
                              crewName={nameFor(v)}
                              color={colorFor(v)}
                              onClick={openSchedule ? () => openSchedule(v.recurring_schedule_id) : undefined}
                            />
                          ))}
                        </SortableContext>
                      )}
                    </MobileDayRow>
                  );
                })}
              </div>
              {/* The dragged chip rendered OUT of the list, fixed to the
                  pointer: without it dnd-kit translates the source chip in
                  place, which lags and clips at the row boundary on a
                  scrolling touch list — "doesn't follow my finger". The face
                  is the shared VisitChipFace (no drag hook, no id of its
                  own); the source chip stays in the row, dimmed via its
                  isDragging opacity, so the row doesn't collapse. */}
              <DragOverlay>
                {activeDayChip && (
                  <VisitChipFace
                    variant="comfortable"
                    visit={activeDayChip}
                    crewName={nameFor(activeDayChip)}
                    today={todayIso}
                    color={colorFor(activeDayChip)}
                    extraClassName="min-w-[240px] max-w-[300px]"
                  />
                )}
              </DragOverlay>
            </DndContext>
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>

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
