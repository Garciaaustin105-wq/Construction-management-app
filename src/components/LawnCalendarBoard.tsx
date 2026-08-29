"use client";

import { useMemo, useState, useEffect, type CSSProperties } from "react";
import Link from "next/link";
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
import { Search, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

export type BoardVisit = {
  id: string;
  due_date: string; // "YYYY-MM-DD"
  status: "pending" | "done" | "skipped" | "paused";
  crew_id: string | null;
  job_name: string;
  service_type: string | null;
  // Needed so a crew-reassign drag can offer to also set the schedule's
  // default crew (recurring_schedules.default_crew_id) for future visits.
  recurring_schedule_id: string;
};

export type BoardCrew = { id: string; name: string };

export type LawnCalendarBoardProps = {
  view: "month" | "week" | "agenda";
  todayIso: string; // "YYYY-MM-DD"
  visits: BoardVisit[];
  crews: BoardCrew[];
  serviceTypes: string[];
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
  monthViewHref: string;
  weekViewHref: string;
  agendaViewHref: string;
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

const STATUS_BADGE: Record<BoardVisit["status"], string> = {
  done: "bg-gray-100 text-gray-500",
  skipped: "bg-gray-100 text-gray-500",
  pending: "bg-amber-100 text-amber-700",
  paused: "bg-blue-100 text-blue-700",
};

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
  color,
  extraClassName,
}: {
  visit: BoardVisit;
  crewName: string;
  color: { dot: string; chip: string };
  extraClassName?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: visit.id });
  const style: CSSProperties = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-tight truncate cursor-grab active:cursor-grabbing ${color.chip} ${
        visit.status === "skipped" ? "line-through opacity-60" : ""
      } ${isDragging ? "opacity-60" : ""} ${extraClassName ?? ""}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${color.dot}`} />
      <span className="font-semibold align-middle">{crewName}</span>
      {visit.service_type && <span className="align-middle"> {visit.service_type}</span>}
    </div>
  );
}

export default function LawnCalendarBoard(props: LawnCalendarBoardProps) {
  const { view, todayIso, visits, crews, serviceTypes, month, week, monthViewHref, weekViewHref, agendaViewHref } =
    props;
  const toast = useToast();

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

  const filteredVisits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return localVisits.filter((v) => {
      if (crewFilter.size > 0) {
        const key = v.crew_id ?? "unassigned";
        if (!crewFilter.has(key)) return false;
      }
      if (statusFilter.size > 0 && !statusFilter.has(v.status)) return false;
      if (serviceFilter && v.service_type !== serviceFilter) return false;
      if (q && !v.job_name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [localVisits, crewFilter, statusFilter, serviceFilter, query]);

  // Agenda grouping — computed unconditionally (cheap) so the hook always
  // runs, rather than only when view === "agenda".
  const agendaGroups = useMemo(() => {
    const map = new Map<string, BoardVisit[]>();
    for (const v of filteredVisits) {
      const arr = map.get(v.due_date) ?? [];
      arr.push(v);
      map.set(v.due_date, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredVisits]);

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
                    <span
                      className={`text-[10px] lg:text-xs font-semibold ${
                        isToday ? "text-blue-700" : "text-gray-400"
                      } self-end leading-none`}
                    >
                      {Number(dateStr.slice(-2))}
                    </span>
                    {shown.map((v, idx) => (
                      <DraggableChip
                        key={v.id}
                        visit={v}
                        crewName={nameFor(v)}
                        color={colorFor(v)}
                        extraClassName={idx >= MAX_CHIPS_PER_CELL ? "hidden lg:block" : ""}
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
            <div className="overflow-x-auto">
              <div className="min-w-[900px]">
                <div className="grid grid-cols-[140px_repeat(7,1fr)] gap-1">
                  <div />
                  {week.days.map((d) => (
                    <div key={d} className="text-center text-[10px] font-semibold text-gray-400 uppercase py-1">
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
                            <DraggableChip key={v.id} visit={v} crewName={nameFor(v)} color={colorFor(v)} />
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

      {/* Agenda view — no drag-and-drop, plain clickable list */}
      {view === "agenda" &&
        (agendaGroups.length === 0 ? (
          <div className="text-center py-10">
            <CalendarDays className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No upcoming visits</p>
            <p className="text-xs text-gray-500 mt-1">Visits in the next 30 days will appear here.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
            {agendaGroups.map(([dateStr, dayVisits]) => {
              const tomorrowIso = (() => {
                const d = new Date(todayIso + "T00:00:00");
                d.setDate(d.getDate() + 1);
                return d.toISOString().slice(0, 10);
              })();
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
                  <div className="px-3 py-2 bg-gray-50 sticky top-0">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>
                  </div>
                  {dayVisits.map((v) => (
                    <Link
                      key={v.id}
                      href={`/lawn/visits/${v.id}`}
                      className="flex items-center gap-2 px-3 py-2 active:bg-gray-50 hover:bg-gray-50"
                    >
                      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${colorFor(v).dot}`} />
                      <span className="text-sm text-gray-900 truncate flex-1 min-w-0">{v.job_name}</span>
                      {v.service_type && <span className="text-xs text-gray-400 shrink-0">{v.service_type}</span>}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize shrink-0 ${STATUS_BADGE[v.status]}`}>
                        {v.status}
                      </span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        ))}

      {/* Crew & Jobs legend — Month and Week views only */}
      {(view === "month" || view === "week") && (
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
    </div>
  );
}
