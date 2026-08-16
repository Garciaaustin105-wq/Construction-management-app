"use client";

// Leaflet map for the lawn route planner. Imported via next/dynamic ssr:false
// from RouteMapPlanner (Leaflet touches `window`/`document` on import, so it
// must never server-render). Renders a numbered marker per mapped stop (the
// number = the stop's position in the dragged list, so the map visually shows
// the route order). Clicking a marker highlights its list row; clicking the
// map while a "drop pin" target is active sets that stop's pin.

import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Marker, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { RouteStop } from "@/lib/lawnRouting";

type Props = {
  stops: RouteStop[]; // ordered list (positions = marker numbers)
  highlightId: string | null;
  dropTargetId: string | null;
  onMarkerClick: (id: string) => void;
  onMapClick: (lat: number, lng: number) => void;
};

function ClickCapture({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
 return null;
}

// Build a numbered, colored pin. index is 1-based for display.
function pinIcon(index: number, status: string, highlighted: boolean) {
  const done = status === "done";
  const bg = done ? "#9ca3af" : "#16a34a"; // gray for done, green for pending
  const ring = highlighted ? "#1d4ed8" : "#ffffff";
  const html = `<div style="
    display:flex;align-items:center;justify-content:center;
    width:26px;height:26px;border-radius:9999px 9999px 9999px 0;
    transform:rotate(-45deg);
    background:${bg};border:2px solid ${ring};
    box-shadow:0 1px 3px rgba(0,0,0,.4);${highlighted ? "width:32px;height:32px;" : ""}">
      <span style="transform:rotate(45deg);color:#fff;font-weight:700;font-size:11px;">${index}</span>
    </div>`;
  return L.divIcon({
    html,
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

export default function RouteMapView({
  stops,
  highlightId,
  dropTargetId,
  onMarkerClick,
  onMapClick,
}: Props) {
  const mapped = stops.filter((s) => s.pos);

  // Fit bounds to the mapped stops so the route is framed on load. If there's
  // only one stop, center on it. If none, center on a sensible US default.
  const center: [number, number] =
    mapped.length === 1
      ? [mapped[0].pos!.lat, mapped[0].pos!.lng]
      : mapped.length > 1
        ? [
            mapped.reduce((s, p) => s + p.pos!.lat, 0) / mapped.length,
            mapped.reduce((s, p) => s + p.pos!.lng, 0) / mapped.length,
          ]
        : [39.5, -98.35];

  return (
    <div
      className={`relative w-full h-[320px] lg:h-[560px] rounded-lg overflow-hidden shadow-sm border ${
        dropTargetId ? "border-blue-500 ring-2 ring-blue-300" : "border-gray-200"
      }`}
    >
      <MapContainer
        center={center}
        zoom={mapped.length > 1 ? 12 : 13}
        scrollWheelZoom
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickCapture onMapClick={onMapClick} />
        {stops.map((s, i) =>
          s.pos ? (
            <Marker
              key={s.id}
              position={[s.pos.lat, s.pos.lng]}
              icon={pinIcon(i + 1, s.status, highlightId === s.id)}
              eventHandlers={{ click: () => onMarkerClick(s.id) }}
            />
          ) : null
        )}
      </MapContainer>
      {dropTargetId && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow">
          Click the map to drop this stop&rsquo;s pin
        </div>
      )}
    </div>
  );
}