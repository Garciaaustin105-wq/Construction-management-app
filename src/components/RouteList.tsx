"use client";

// Draggable, ordered list of the day's lawn stops for the route planner.
// @dnd-kit/sortable powers drag-to-reorder; the parent owns the `stops` array
// (in display order) and we call onReorder with the new order on drop. The row
// number (index+1) matches the pin number on the map, so map and list stay in
// sync. Crew assignment is a <select> per row (with the stale-"Crew (removed)"
// fallback so a controlled <select> never has an invalid value). Unmapped
// stops get a Geocode button (address → pin) + a "On map" button (click the
// map to drop the pin).

import Link from "next/link";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MapPin, Loader2, Search } from "lucide-react";
import type { RouteStop, CrewInfo } from "@/lib/lawnRouting";

type Props = {
  stops: RouteStop[];
  crews: CrewInfo[];
  crewAssign: Record<string, string | null>;
  highlightId: string | null;
  geocoding: Record<string, boolean>;
  dropTargetId: string | null;
  onReorder: (next: RouteStop[]) => void;
  onAssign: (visitId: string, crewId: string | null) => void;
  onHighlight: (id: string | null) => void;
  onGeocode: (visitId: string) => void;
  onSetOnMap: (visitId: string | null) => void;
};

function StopRow({
  stop,
  index,
  crews,
  assignedCrew,
  highlighted,
  isGeocoding,
  isDropTarget,
  onAssign,
  onHighlight,
  onGeocode,
  onSetOnMap,
}: {
  stop: RouteStop;
  index: number;
  crews: CrewInfo[];
  assignedCrew: string | null;
  highlighted: boolean;
  isGeocoding: boolean;
  isDropTarget: boolean;
  onAssign: (crewId: string | null) => void;
  onHighlight: () => void;
  onGeocode: () => void;
  onSetOnMap: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stop.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // The assigned crew may have left the crew/superintendent roster — keep a
  // stale "Crew (removed)" option so the <select> value stays valid (controlled
  // selects can't hold a value with no matching option). Review LOW-1 from the
  // old planner, preserved.
  const crewStillListed = !assignedCrew || crews.some((c) => c.id === assignedCrew);

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => onHighlight()}
      className={`flex items-start gap-2 p-2 border-b border-gray-100 bg-white ${
        highlighted ? "ring-2 ring-blue-400" : ""
      } ${isDragging ? "opacity-60" : ""} ${isDropTarget ? "bg-blue-50" : ""}`}
    >
      <button
        {...attributes}
        {...listeners}
        // Full-height grab strip (iOS-style reorder control). The handle was a
        // 16px icon — on touch a finger would land on the row body (no drag
        // listeners) and scroll instead of drag. self-stretch + -my-2 make the
        // strip span the whole row height (into the padding) so the finger
        // always hits the listener. touch-none stops the browser stealing the
        // touch for scroll/zoom; select-none + -webkit-touch-callout:none stop
        // the native long-press "Copy/Look Up" callout (iOS) / text-select menu
        // (Android) firing during the 150ms press-and-hold. user-select:none on
        // the handle only; the row body stays selectable so the office can
        // still copy an address.
        className="self-stretch flex items-center justify-center px-1.5 -my-2 text-gray-300 hover:text-gray-500 touch-none cursor-grab active:cursor-grabbing select-none [-webkit-touch-callout:none]"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-5 h-5" />
      </button>
      <span
        className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${
          stop.status === "done" ? "bg-gray-400" : "bg-green-600"
        }`}
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={`/lawn/visits/${stop.id}`}
          className="text-sm font-medium text-gray-900 truncate block hover:underline"
        >
          {stop.jobName}
        </Link>
        <p className="text-xs text-gray-500 truncate">
          {stop.customerName ? `${stop.customerName} · ` : ""}
          {stop.address ?? "no address"}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {stop.serviceType && (
            <span className="text-[10px] text-gray-500">{stop.serviceType}</span>
          )}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${
              stop.status === "done"
                ? "bg-gray-100 text-gray-500"
                : "bg-amber-100 text-amber-700"
            }`}
          >
            {stop.status}
          </span>
          {!stop.pos && !isGeocoding && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onGeocode();
                }}
                className="inline-flex items-center gap-1 text-[10px] text-blue-600 font-medium"
              >
                <Search className="w-3 h-3" /> Geocode
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSetOnMap();
                }}
                className={`inline-flex items-center gap-1 text-[10px] font-medium ${
                  isDropTarget ? "text-blue-700" : "text-gray-500"
                }`}
              >
                <MapPin className="w-3 h-3" /> {isDropTarget ? "Click map" : "On map"}
              </button>
            </>
          )}
          {isGeocoding && (
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
              <Loader2 className="w-3 h-3 animate-spin" /> geocoding…
            </span>
          )}
          {stop.pos && (
            <span className="inline-flex items-center gap-1 text-[10px] text-green-700">
              <MapPin className="w-3 h-3" /> pinned
            </span>
          )}
        </div>
      </div>
      <select
        value={assignedCrew ?? ""}
        onChange={(e) => onAssign(e.target.value || null)}
        onClick={(e) => e.stopPropagation()}
        className="text-xs border border-gray-300 rounded-lg px-1.5 py-1 bg-white flex-shrink-0 max-w-[120px]"
      >
        <option value="">Unassigned</option>
        {crews.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {!crewStillListed && <option value={assignedCrew!}>Crew (removed)</option>}
      </select>
    </div>
  );
}

export default function RouteList({
  stops,
  crews,
  crewAssign,
  highlightId,
  geocoding,
  dropTargetId,
  onReorder,
  onAssign,
  onHighlight,
  onGeocode,
  onSetOnMap,
}: Props) {
  // ONE PointerSensor for both desktop + mobile. Registering PointerSensor +
  // TouchSensor together double-binds a touch (both pointerdown + touchstart
  // fire) and the two sensors fight over the gesture — that was the "mobile
  // drag won't start / won't follow my finger" bug. PointerSensor alone fires
  // pointerdown for mouse, pen, AND touch, so a single sensor covers all three.
  // On a coarse pointer (touch) we require a press-and-hold (150ms, ≤8px drift)
  // before the drag activates, so a quick tap scrolls/selects instead of
  // grabbing; on a fine pointer (mouse) a 6px slide starts it immediately.
  const isCoarse =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isCoarse
        ? { delay: 150, tolerance: 8 }
        : { distance: 6 },
    })
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = stops.findIndex((s) => s.id === active.id);
    const newIndex = stops.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(stops, oldIndex, newIndex));
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={stops.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          {stops.map((s, i) => (
            <StopRow
              key={s.id}
              stop={s}
              index={i}
              crews={crews}
              assignedCrew={crewAssign[s.id] ?? null}
              highlighted={highlightId === s.id}
              isGeocoding={!!geocoding[s.id]}
              isDropTarget={dropTargetId === s.id}
              onAssign={(crew) => onAssign(s.id, crew)}
              onHighlight={() => onHighlight(highlightId === s.id ? null : s.id)}
              onGeocode={() => onGeocode(s.id)}
              onSetOnMap={() => onSetOnMap(dropTargetId === s.id ? null : s.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}