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
  TouchSensor,
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
        // touch-none stops the browser stealing the touch for scroll/zoom;
        // select-none + -webkit-touch-callout:none stop the native long-press
        // "Copy/Look Up" callout (iOS) / text-select menu (Android) from firing
        // during the 200ms TouchSensor press-and-hold — that was the "copy items
        // pops up when I hold" symptom. user-select:none on the handle only; the
        // row body stays selectable so the office can still copy an address.
        className="mt-0.5 text-gray-300 hover:text-gray-500 touch-none cursor-grab active:cursor-grabbing select-none [-webkit-touch-callout:none]"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
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
  // PointerSensor for desktop mouse; TouchSensor for mobile. On touch a
  // press-and-hold (delay 200ms, tolerance 8px) activates the drag, so a quick
  // tap on the row doesn't — and the grip handle's `touch-none` keeps the
  // browser from stealing the touch for scrolling. PointerSensor alone relied
  // on a 5px slide, which is flaky on touch (the grip "wouldn't follow the
  // finger" on mobile).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
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