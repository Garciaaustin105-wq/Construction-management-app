"use client";
import React, { useMemo, useRef, useState } from "react";
import { computeCriticalPath, dayIndex, fromDayIndex } from "@/lib/criticalPath";

const LABEL_W = 224;
const ROW_H = 40;
const HEADER_H = 44;
const BAR_H = 22;

export interface GanttTask {
  id: string;
  title: string;
  kind: "task" | "phase" | "milestone";
  cost_code_id: string | null;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string | null; // null for milestone
  position: number;
  percent_complete: number; // 0..100
  predecessor_ids: string[] | null;
  dependency_type: string | null;
  assigned_to: string | null;
}

export interface GanttCostCode {
  id: string;
  code: string;
  name: string;
}
export interface GanttAssignee {
  id: string;
  full_name: string | null;
  email: string;
}

type DragState = {
  id: string;
  mode: "move" | "resize-l" | "resize-r" | "link";
  startX: number;
  origStart: string;
  origEnd: string | null;
  ghostStart: string;
  ghostEnd: string | null;
};

// Hit-test the bar under a pointer (used for drag-to-link drop detection).
function hitTaskId(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const bar = el.closest("[data-gtask]") as HTMLElement | null;
  return bar?.getAttribute("data-gtask") ?? null;
}

export default function GanttChart(props: {
  tasks: GanttTask[];
  canEdit: boolean;
  costCodes: GanttCostCode[];
  assignees: GanttAssignee[];
  jobScheduledStart: string | null; // fallback span if no tasks
  jobScheduledEnd: string | null;
  onUpdate: (id: string, patch: Partial<GanttTask>) => void;
  onLink: (predecessorId: string, successorId: string) => void;
  onUnlink: (successorId: string, predecessorId: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}) {
  const [zoom, setZoom] = useState<"day" | "week" | "month">("day");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [linkTarget, setLinkTarget] = useState<string | null>(null);
  // Origin of the active drag, written in pointer handlers (NOT during render)
  // so the move/up handlers can compute the committed position from the origin
  // regardless of React render timing.
  const dragRef = useRef<DragState | null>(null);

  const dayWidth = zoom === "day" ? 32 : zoom === "week" ? 16 : 8;

  const spanStartIdx = useMemo(() => {
    if (props.tasks.length) {
      return Math.min(...props.tasks.map((t) => dayIndex(t.start_date)));
    }
    const todayIdx = dayIndex(new Date().toISOString().slice(0, 10));
    return props.jobScheduledStart ? dayIndex(props.jobScheduledStart) : todayIdx - 14;
  }, [props.tasks, props.jobScheduledStart]);

  const spanEndIdx = useMemo(() => {
    if (props.tasks.length) {
      return Math.max(...props.tasks.map((t) => dayIndex(t.end_date ?? t.start_date)));
    }
    const todayIdx = dayIndex(new Date().toISOString().slice(0, 10));
    return props.jobScheduledEnd ? dayIndex(props.jobScheduledEnd) : todayIdx + 14;
  }, [props.tasks, props.jobScheduledEnd]);

  const totalDays = Math.max(1, spanEndIdx - spanStartIdx + 1);
  const totalWidth = totalDays * dayWidth;

  const sortedTasks = useMemo(
    () => [...props.tasks].sort((a, b) => a.position - b.position),
    [props.tasks]
  );
  const idToIndex = useMemo(
    () => new Map(sortedTasks.map((t, i) => [t.id, i])),
    [sortedTasks]
  );
  const idToTask = useMemo(() => new Map(props.tasks.map((t) => [t.id, t])), [props.tasks]);

  const today = new Date().toISOString().slice(0, 10);
  const todayIdx = dayIndex(today);
  const todayOffset = todayIdx - spanStartIdx;

  const cpm = useMemo(
    () =>
      computeCriticalPath(
        props.tasks.map((t) => ({
          id: t.id,
          start_date: t.start_date,
          end_date: t.end_date,
          predecessor_ids: t.predecessor_ids,
        }))
      ),
    [props.tasks]
  );
  const criticalIds = useMemo(() => {
    const s = new Set<string>();
    for (const [id, e] of cpm.entries) if (e.isCritical) s.add(id);
    return s;
  }, [cpm]);

  const selectedTask = props.tasks.find((t) => t.id === selectedId) ?? null;

  // ── Drag handlers (pointer capture: the captured element receives all
  // move/up events; positions are derived from the drag origin so stale
  // closures are harmless). dragRef is written only here, never in render.
  const beginDrag = (d: DragState, e: React.PointerEvent) => {
    dragRef.current = d;
    setDrag(d);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const handleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const deltaDays = Math.round(dx / dayWidth);
    if (d.mode === "link") {
      const id = hitTaskId(e.clientX, e.clientY);
      setLinkTarget(id && id !== d.id ? id : null);
      return;
    }
    if (Math.abs(dx) < 4) return; // ignore micro-movement (tap threshold)
    if (d.mode === "move") {
      const ns = fromDayIndex(dayIndex(d.origStart) + deltaDays);
      const ne = d.origEnd ? fromDayIndex(dayIndex(d.origEnd) + deltaDays) : null;
      setDrag({ ...d, ghostStart: ns, ghostEnd: ne });
    } else if (d.mode === "resize-l") {
      let ns = fromDayIndex(dayIndex(d.origStart) + deltaDays);
      if (d.origEnd && dayIndex(ns) > dayIndex(d.origEnd)) ns = d.origEnd;
      setDrag({ ...d, ghostStart: ns });
    } else if (d.mode === "resize-r") {
      if (!d.origEnd) return;
      let ne = fromDayIndex(dayIndex(d.origEnd) + deltaDays);
      if (dayIndex(ne) < dayIndex(d.origStart)) ne = d.origStart;
      setDrag({ ...d, ghostEnd: ne });
    }
  };

  const finishDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const dx = e.clientX - d.startX;
    const deltaDays = Math.round(dx / dayWidth);
    const moved = Math.abs(dx) >= 4;

    if (d.mode === "link") {
      const id = hitTaskId(e.clientX, e.clientY);
      if (id && id !== d.id) {
        const succ = props.tasks.find((x) => x.id === id);
        if (succ && !(succ.predecessor_ids ?? []).includes(d.id)) {
          props.onLink(d.id, id);
        }
      }
      dragRef.current = null;
      setDrag(null);
      setLinkTarget(null);
      return;
    }

    if (!moved) {
      setSelectedId(d.id); // tap = select (open edit panel)
      dragRef.current = null;
      setDrag(null);
      return;
    }

    if (d.mode === "move") {
      const ns = fromDayIndex(dayIndex(d.origStart) + deltaDays);
      const ne = d.origEnd ? fromDayIndex(dayIndex(d.origEnd) + deltaDays) : null;
      props.onUpdate(d.id, { start_date: ns, end_date: ne });
    } else if (d.mode === "resize-l") {
      let ns = fromDayIndex(dayIndex(d.origStart) + deltaDays);
      if (d.origEnd && dayIndex(ns) > dayIndex(d.origEnd)) ns = d.origEnd;
      props.onUpdate(d.id, { start_date: ns });
    } else if (d.mode === "resize-r") {
      if (d.origEnd) {
        let ne = fromDayIndex(dayIndex(d.origEnd) + deltaDays);
        if (dayIndex(ne) < dayIndex(d.origStart)) ne = d.origStart;
        props.onUpdate(d.id, { end_date: ne });
      }
    }
    dragRef.current = null;
    setDrag(null);
  };

  const startMove = (t: GanttTask) => (e: React.PointerEvent) => {
    if (!props.canEdit) return;
    e.preventDefault();
    beginDrag(
      { id: t.id, mode: "move", startX: e.clientX, origStart: t.start_date, origEnd: t.end_date, ghostStart: t.start_date, ghostEnd: t.end_date },
      e
    );
  };
  const startResize = (t: GanttTask, side: "l" | "r") => (e: React.PointerEvent) => {
    if (!props.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag(
      { id: t.id, mode: side === "l" ? "resize-l" : "resize-r", startX: e.clientX, origStart: t.start_date, origEnd: t.end_date, ghostStart: t.start_date, ghostEnd: t.end_date },
      e
    );
  };
  const startLink = (t: GanttTask) => (e: React.PointerEvent) => {
    if (!props.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag(
      { id: t.id, mode: "link", startX: e.clientX, origStart: t.start_date, origEnd: t.end_date, ghostStart: t.start_date, ghostEnd: t.end_date },
      e
    );
    setLinkTarget(null);
  };

  const xForStart = (s: string) => (dayIndex(s) - spanStartIdx) * dayWidth;
  const widthFor = (s: string, e: string | null) =>
    Math.max(10, (dayIndex(e ?? s) - dayIndex(s) + 1) * dayWidth);

  const innerHeight = HEADER_H + sortedTasks.length * ROW_H;

  return (
    <div>
      {cpm.cycleError && (
        <div className="bg-red-100 text-red-800 p-2 mb-2 text-xs rounded">
          A dependency cycle exists — some links were not drawn.
        </div>
      )}
      <div className="flex items-center gap-2 mb-2 px-1">
        <div className="flex rounded border border-gray-300 overflow-hidden">
          {(["day", "week", "month"] as const).map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={`px-3 py-1 text-xs capitalize ${
                zoom === z ? "bg-blue-600 text-white" : "bg-white text-gray-600"
              }`}
            >
              {z}
            </button>
          ))}
        </div>
        {props.canEdit && (
          <button onClick={props.onCreate} className="text-xs bg-blue-600 text-white py-1 px-3 rounded ml-auto">
            + Add task
          </button>
        )}
      </div>

      <div className="overflow-auto border rounded-lg bg-white" style={{ maxHeight: "72vh" }}>
        <div style={{ position: "relative", width: LABEL_W + totalWidth, height: innerHeight }}>
          {/* Background grid (weekends + week gridlines) */}
          <div className="absolute inset-0 z-0 pointer-events-none">
            {[...Array(totalDays)].map((_, i) => {
              const date = fromDayIndex(spanStartIdx + i);
              const day = new Date(date).getUTCDay();
              return (
                <div key={`g-${i}`}>
                  {(day === 0 || day === 6) && (
                    <div
                      className="absolute top-0 h-full bg-gray-50"
                      style={{ left: LABEL_W + i * dayWidth, width: dayWidth }}
                    />
                  )}
                  {day === 1 && (
                    <div
                      className="absolute top-0 h-full border-l border-gray-200"
                      style={{ left: LABEL_W + i * dayWidth }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Header */}
          <div className="sticky top-0 z-40 flex h-11 bg-gray-50 border-b">
            <div className="sticky left-0 z-50 w-56 shrink-0 bg-gray-50 border-r flex items-center px-3 text-xs font-semibold text-gray-500">
              Task
            </div>
            <div className="relative h-11">
              {[...Array(totalDays)].map((_, i) => {
                const date = fromDayIndex(spanStartIdx + i);
                const day = new Date(date).getUTCDay();
                if (day !== 1) return null;
                return (
                  <span
                    key={`h-${i}`}
                    className="absolute top-0 px-2 text-[11px] text-gray-600 leading-[44px]"
                    style={{ left: i * dayWidth }}
                  >
                    {new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Rows */}
          {sortedTasks.map((t) => {
            const isDragging = drag?.id === t.id && drag.mode !== "link";
            const dispStart = isDragging ? drag!.ghostStart : t.start_date;
            const dispEnd = isDragging ? drag!.ghostEnd : t.end_date;
            const isLinkDrop = linkTarget === t.id && drag?.mode === "link";
            return (
              <div key={t.id} className="flex" style={{ height: ROW_H }}>
                {/* Label cell */}
                <div className="sticky left-0 z-30 w-56 shrink-0 bg-white border-r border-b border-gray-100 flex items-center gap-1 px-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      t.kind === "task" ? "bg-blue-500" : t.kind === "phase" ? "bg-indigo-500" : "bg-amber-500"
                    }`}
                  />
                  <span className={`text-xs text-gray-800 truncate ${criticalIds.has(t.id) ? "text-red-600 font-medium" : ""}`}>
                    {t.title}
                  </span>
                  <span className="text-[10px] text-gray-400 shrink-0">{t.percent_complete}%</span>
                </div>

                {/* Timeline cell */}
                <div className="relative h-full" style={{ width: totalWidth }}>
                  {t.kind === "milestone" ? (
                    <div
                      data-gtask={t.id}
                      onPointerDown={startMove(t)}
                      onPointerMove={handleMove}
                      onPointerUp={finishDrag}
                      onPointerCancel={finishDrag}
                      className={`absolute bg-amber-500 rotate-45 ${
                        criticalIds.has(t.id) ? "ring-2 ring-red-500" : ""
                      } ${isLinkDrop ? "ring-2 ring-blue-500" : ""} ${isDragging ? "opacity-70" : ""}`}
                      style={{
                        left: xForStart(dispStart) - 7,
                        top: (ROW_H - 14) / 2,
                        width: 14,
                        height: 14,
                        touchAction: "none",
                        cursor: props.canEdit ? "grab" : "default",
                      }}
                      title={t.title}
                    />
                  ) : (
                    <div
                      data-gtask={t.id}
                      onPointerDown={startMove(t)}
                      onPointerMove={handleMove}
                      onPointerUp={finishDrag}
                      onPointerCancel={finishDrag}
                      className={`absolute rounded-md overflow-hidden ${
                        t.kind === "task" ? "bg-blue-100 border border-blue-300" : "bg-indigo-100 border border-indigo-400"
                      } ${criticalIds.has(t.id) ? "ring-2 ring-red-500" : ""} ${
                        isLinkDrop ? "ring-2 ring-blue-500" : ""
                      } ${isDragging ? "opacity-70" : ""}`}
                      style={{
                        left: xForStart(dispStart),
                        top: (ROW_H - BAR_H) / 2,
                        width: widthFor(dispStart, dispEnd),
                        height: BAR_H,
                        touchAction: "none",
                        cursor: props.canEdit ? "grab" : "default",
                      }}
                      title={t.title}
                    >
                      <div
                        className={`absolute inset-y-0 left-0 ${t.kind === "task" ? "bg-blue-500" : "bg-indigo-500"}`}
                        style={{ width: `${t.percent_complete}%` }}
                      />
                      <span
                        className={`absolute inset-0 flex items-center px-1.5 text-[11px] text-gray-700 truncate pointer-events-none ${
                          t.kind === "phase" ? "font-semibold" : ""
                        }`}
                      >
                        {t.title}
                      </span>
                    </div>
                  )}

                  {/* Drag handles (edit only) */}
                  {props.canEdit && (
                    <>
                      <div
                        onPointerDown={startResize(t, "l")}
                        onPointerMove={handleMove}
                        onPointerUp={finishDrag}
                        onPointerCancel={finishDrag}
                        className="absolute top-0 bottom-0 w-1.5 cursor-ew-resize"
                        style={{ left: xForStart(dispStart) - 1, touchAction: "none" }}
                      />
                      {t.kind !== "milestone" && (
                        <div
                          onPointerDown={startResize(t, "r")}
                          onPointerMove={handleMove}
                          onPointerUp={finishDrag}
                          onPointerCancel={finishDrag}
                          className="absolute top-0 bottom-0 w-1.5 cursor-ew-resize"
                          style={{ left: xForStart(dispStart) + widthFor(dispStart, dispEnd) - 2, touchAction: "none" }}
                        />
                      )}
                      {/* Link handle: small circle at the right edge */}
                      <div
                        onPointerDown={startLink(t)}
                        onPointerMove={handleMove}
                        onPointerUp={finishDrag}
                        onPointerCancel={finishDrag}
                        className="absolute w-4 h-4 rounded-full bg-white border-2 border-blue-500 cursor-crosshair"
                        style={{
                          left: xForStart(dispStart) + widthFor(dispStart, dispEnd) - 8,
                          top: (ROW_H - 16) / 2,
                          touchAction: "none",
                        }}
                        title="Drag to another task to link (FS)"
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {/* SVG overlay: dependency arrows + today line */}
          <svg className="absolute top-0 z-20 pointer-events-none" style={{ left: LABEL_W, width: totalWidth, height: innerHeight }}>
            {sortedTasks.map((t) =>
              (t.predecessor_ids ?? []).map((pid) => {
                const p = idToTask.get(pid);
                if (!p) return null;
                const px = (dayIndex(p.end_date ?? p.start_date) - spanStartIdx + 1) * dayWidth;
                const py = HEADER_H + (idToIndex.get(p.id) ?? 0) * ROW_H + ROW_H / 2;
                const tx = (dayIndex(t.start_date) - spanStartIdx) * dayWidth;
                const ty = HEADER_H + (idToIndex.get(t.id) ?? 0) * ROW_H + ROW_H / 2;
                const midX = Math.min(px + 6, tx - 6);
                const stroke = criticalIds.has(p.id) && criticalIds.has(t.id) ? "#ef4444" : "#94a3b8";
                return (
                  <g key={`${p.id}-${t.id}`}>
                    <path d={`M ${px} ${py} L ${midX} ${py} L ${midX} ${ty} L ${tx} ${ty}`} stroke={stroke} strokeWidth={1.5} fill="none" />
                    <polygon points="0,0 -6,-3 -6,3" transform={`translate(${tx},${ty})`} stroke={stroke} fill={stroke} />
                  </g>
                );
              })
            )}
            {todayOffset >= 0 && todayOffset < totalDays && (
              <line x1={todayOffset * dayWidth} x2={todayOffset * dayWidth} y1={0} y2={innerHeight} stroke="#ef4444" strokeWidth={1.5} />
            )}
          </svg>
        </div>
      </div>

      {selectedId && selectedTask && props.canEdit && (
        <EditPanel
          key={selectedId}
          task={selectedTask}
          costCodes={props.costCodes}
          assignees={props.assignees}
          allTasks={props.tasks}
          onUpdate={props.onUpdate}
          onUnlink={props.onUnlink}
          onDelete={props.onDelete}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// Edit panel — a keyed child so it initializes its own draft from the task on
// mount (no set-state-in-effect sync). Remounts when a different task is
// selected; closes after Save/Delete.
function EditPanel({
  task,
  costCodes,
  assignees,
  allTasks,
  onUpdate,
  onUnlink,
  onDelete,
  onClose,
}: {
  task: GanttTask;
  costCodes: GanttCostCode[];
  assignees: GanttAssignee[];
  allTasks: GanttTask[];
  onUpdate: (id: string, patch: Partial<GanttTask>) => void;
  onUnlink: (successorId: string, predecessorId: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [panel, setPanel] = useState<Partial<GanttTask>>({ ...task });

  const change = (key: keyof GanttTask, value: string | number | null) =>
    setPanel((prev) => ({ ...prev, [key]: value }));

  const save = () => {
    onUpdate(task.id, panel);
    onClose();
  };
  const remove = () => {
    onDelete(task.id);
    onClose();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 lg:inset-x-auto lg:right-4 lg:top-20 lg:bottom-auto lg:w-80 bg-white rounded-t-lg lg:rounded-lg shadow-lg border p-4 space-y-3 z-50 max-h-[80vh] overflow-y-auto">
      <div className="flex justify-between items-center">
        <h3 className="text-base font-semibold">Edit Task</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <label className="block">
        <span className="text-xs font-medium text-gray-500">Title</span>
        <input
          type="text"
          value={panel.title ?? ""}
          onChange={(e) => change("title", e.target.value)}
          className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-500">Type</span>
        <select
          value={panel.kind ?? "task"}
          onChange={(e) => {
            const v = e.target.value as GanttTask["kind"];
            change("kind", v);
            if (v === "milestone") change("end_date", null);
            else if (!panel.end_date) change("end_date", panel.start_date ?? "");
          }}
          className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        >
          <option value="task">Task</option>
          <option value="phase">Phase</option>
          <option value="milestone">Milestone</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-500">Start</span>
          <input
            type="date"
            value={(panel.start_date ?? "").slice(0, 10)}
            onChange={(e) => change("start_date", e.target.value)}
            className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-500">End</span>
          <input
            type="date"
            value={(panel.end_date ?? "").slice(0, 10)}
            onChange={(e) => change("end_date", e.target.value)}
            disabled={panel.kind === "milestone"}
            className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm disabled:bg-gray-100"
          />
        </label>
      </div>
      <div>
        <span className="text-xs font-medium text-gray-500">% Complete: {panel.percent_complete ?? 0}%</span>
        <input
          type="range"
          min={0}
          max={100}
          value={panel.percent_complete ?? 0}
          onChange={(e) => change("percent_complete", parseInt(e.target.value, 10))}
          className="mt-1 block w-full"
        />
      </div>
      <label className="block">
        <span className="text-xs font-medium text-gray-500">Cost code</span>
        <select
          value={panel.cost_code_id ?? ""}
          onChange={(e) => change("cost_code_id", e.target.value || null)}
          className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        >
          <option value="">None</option>
          {costCodes.map((cc) => (
            <option key={cc.id} value={cc.id}>{`${cc.code} · ${cc.name}`}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-500">Assigned to</span>
        <select
          value={panel.assigned_to ?? ""}
          onChange={(e) => change("assigned_to", e.target.value || null)}
          className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
        >
          <option value="">Unassigned</option>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>{a.full_name ?? a.email}</option>
          ))}
        </select>
      </label>
      <div>
        <span className="text-xs font-medium text-gray-500">Predecessors</span>
        <div className="flex flex-wrap gap-1 mt-1">
          {(panel.predecessor_ids ?? []).map((pid) => {
            const p = allTasks.find((x) => x.id === pid);
            if (!p) return null;
            return (
              <span key={pid} className="bg-gray-100 text-gray-800 px-2 py-1 rounded flex items-center gap-1 text-xs">
                {p.title}
                <button
                  onClick={() => {
                    onUnlink(task.id, pid);
                    setPanel((prev) => ({
                      ...prev,
                      predecessor_ids: (prev.predecessor_ids ?? []).filter((x) => x !== pid),
                    }));
                  }}
                  className="text-red-600 hover:text-red-800"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            );
          })}
          {(panel.predecessor_ids ?? []).length === 0 && (
            <span className="text-xs text-gray-400">None — drag the blue dot on a bar to link.</span>
          )}
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button onClick={save} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold">
          Save
        </button>
        <button onClick={remove} className="bg-white border border-red-300 text-red-600 px-3 py-2 rounded-lg text-sm">
          Delete
        </button>
      </div>
    </div>
  );
}