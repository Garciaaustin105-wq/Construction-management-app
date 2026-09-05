/* src/components/LawnMeasurementMap.tsx
 *
 * Multi-area lawn measurement map (v2). Draws one or more NAMED,
 * COLOR-CODED lawn areas (front yard, back beds, ...) on a Google Map, each
 * persisted as its own `estimate_areas` row. Replaces the single-polygon v1
 * the user rejected as "very confusing": that version had one unnamed
 * shape, no colors, and tiny click-only vertices with no way to fix a
 * misplaced point. Every vertex here is a big draggable handle, edge
 * midpoints insert new points, double-click removes one, and undo/redo
 * backs out mistakes. Only one area is edited at a time; the rest stay
 * visible underneath as static colored polygons.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  AREA_COLORS,
  areaSqftFromPoints,
  createEstimateArea,
  deleteEstimateArea,
  listEstimateAreas,
  nextAreaColor,
  syncEstimateTotals,
  totalAreaSqft,
  updateEstimateArea,
  type EstimateArea,
  type LatLng,
  ACCESS_TAG_PRESETS,
  edgeHitAt,
} from "@/lib/estimateAreas";
import { loadGoogleMaps } from "@/lib/googleMaps";
import { listPricedServices, sqftPrice, type PricedService } from "@/lib/lawnMeasurement";
import {
  isPlantArea,
  listPlantCatalogue,
  plantSnapshot,
  readPlantSnapshot,
  type PlantProduct,
  type PlantSize,
  type PlantWithSizes,
} from "@/lib/plantProducts";
import { formatMoney } from "@/lib/money";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { ChevronDown, ChevronUp, Ruler, X } from "lucide-react";

type Props = {
  estimateId: string;
  address: string | null;
  onAddLineItem: (line: {
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    // Set by catalogue-priced items (plants); omitted by $/sq ft area pricing,
    // which has no cost side.
    internal_cost?: number | null;
  }) => void;
  // Workspace content rendered INSIDE the floating panel (below the area
  // controls) so line items are reachable without navigating away from the
  // map — the workspace hands its line-item section through this slot.
  panelSlot?: React.ReactNode;
  // Optional live summary shown on the collapsed pill (item count + running
  // total) so the number still moves while the panel is folded away.
  panelBadge?: React.ReactNode;
  // Areas are loaded and owned HERE, not by the workspace. The labor panel
  // needs them to build the plant legend, so the map publishes them upward
  // after every load rather than the workspace fetching them a second time.
  onAreasChange?: (areas: EstimateArea[]) => void;
};

type Draft = { areaId: string | "new"; vertices: LatLng[]; tags: string[] } | null;

const FALLBACK_CENTER: LatLng = { lat: 27.9506, lng: -82.4572 }; // Tampa

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function LawnMeasurementMap({
  estimateId,
  address,
  onAddLineItem,
  panelSlot,
  panelBadge,
  onAreasChange,
}: Props): React.ReactElement {
  /* ---------- State ---------- */
  const [areas, setAreas] = useState<EstimateArea[]>([]);
  const [draft, setDraft] = useState<Draft>(null);
  const [history, setHistory] = useState<LatLng[][]>([]);
  const [future, setFuture] = useState<LatLng[][]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loadingAreas, setLoadingAreas] = useState<boolean>(true);
  const [editName, setEditName] = useState<{ [id: string]: string }>({});
  const [pricedServices, setPricedServices] = useState<PricedService[]>([]);
  // The plant catalogue, loaded once per org for the placement picker.
  // listPlantCatalogue already orders species by name and sizes by sort_order
  // — re-sorting sizes here would put "15 gal" before "3 gal" alphabetically,
  // the exact bug sort_order exists to prevent.
  const [plantCatalogue, setPlantCatalogue] = useState<PlantWithSizes[]>([]);
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  // Placement mode: armed with a species+size pair, a map click then plants
  // one. Mutually exclusive with the draft — see startPlacement below.
  const [placing, setPlacing] = useState<{ product: PlantProduct; size: PlantSize } | null>(null);
  const [pickerProductId, setPickerProductId] = useState<string>("");
  const [pickerSizeId, setPickerSizeId] = useState<string>("");
  // The selected placed plant (for the inspect card). Empty string = none.
  const [selectedPlantId, setSelectedPlantId] = useState<string>("");
  // Per-placement note drafts, keyed by area id — mirrors editName.
  const [plantNote, setPlantNote] = useState<{ [id: string]: string }>({});
  const [selectedAreaId, setSelectedAreaId] = useState<string>("");
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [mapReady, setMapReady] = useState(false);
  // Centre the map once per mount. A ref, not state: flipping it must not
  // re-run the effect that sets it.
  const centeredRef = useRef(false);

  /* ---------- Floating panel ---------- */
  // The map fills its whole container and every control floats over it. Two
  // states because the two surfaces behave differently: on desktop (lg+) the
  // panel is a docked column that starts open; on a phone it is a bottom
  // sheet that starts COLLAPSED to one pill, so the map owns the screen on
  // load and the user taps the pill to pick out areas or items. Either way
  // the panel folds away completely — it must never cover so much map that
  // drawing becomes awkward.
  const isDesktop = useIsDesktop();
  const [dockOpen, setDockOpen] = useState(true); // lg+ docked column
  const [sheetOpen, setSheetOpen] = useState(false); // phone bottom sheet
  const panelOpen = isDesktop ? dockOpen : sheetOpen;
  const setPanelOpen = isDesktop ? setDockOpen : setSheetOpen;

  /* ---------- Toast ---------- */
  const toast = useToast();

  /* ---------- Refs ---------- */
  const mapRef = useRef<google.maps.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const staticPolygonsRef = useRef<google.maps.Polygon[]>([]);
  // Placed plants (kind="point"). Rebuilt wholesale on every areas change —
  // always tear down before rebuild, or a 200-plant estimate leaks markers
  // until the map melts.
  const plantMarkersRef = useRef<google.maps.Marker[]>([]);
  const draftPolygonRef = useRef<google.maps.Polygon | null>(null);
  const vertexMarkersRef = useRef<google.maps.Marker[]>([]);
  const midMarkersRef = useRef<google.maps.Marker[]>([]);
  // Mirrors `draft` so the map click listener (registered once, when the map
  // is created) always reads the current draft instead of a stale closure.
  const draftRef = useRef<Draft>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // Same treatment for placement mode: the map click listener is registered
  // once and reads this ref, so it never sees a stale closure.
  const placingRef = useRef(placing);
  useEffect(() => {
    placingRef.current = placing;
  }, [placing]);
  // In-flight guard for placePlant. A ref, not state: state updates are async
  // and an impatient second tap can beat the re-render — this repo has
  // already shipped a double-submit bug from exactly that (crew/photo).
  const placingSaveRef = useRef(false);
  // placePlant is called from the once-registered map click listener, so it
  // must never read state that could be stale — orgId arrives AFTER the map
  // is created, and a closure over the state would hold `null` forever.
  const orgIdRef = useRef(orgId);
  useEffect(() => {
    orgIdRef.current = orgId;
  }, [orgId]);

  /* ---------- Supabase client ---------- */
  // Held in a ref so an inline arrow from the parent does not change
  // loadAreas' identity on every render, which would re-fire its effects.
  const onAreasChangeRef = useRef(onAreasChange);
  useEffect(() => {
    onAreasChangeRef.current = onAreasChange;
  }, [onAreasChange]);

  const supabase = createClient();

  /* ---------- Load organization id + areas ---------- */
  const loadAreas = async () => {
    setLoadingAreas(true);
    const { data, error } = await listEstimateAreas(supabase, estimateId);
    setAreas(data);
    onAreasChangeRef.current?.(data);
    if (error) setErrorMsg(`Load areas: ${error}`);
    setLoadingAreas(false);
    return data;
  };
  // placePlant (defined below, called from the once-registered map listener)
  // reaches the LATEST loadAreas through this ref so placePlant's identity
  // can stay stable via useCallback.
  const loadAreasRef = useRef(loadAreas);
  useEffect(() => {
    loadAreasRef.current = loadAreas;
  });

  /* ---------- Place a plant (kind="point") ---------- */
  // Defined BEFORE the map-init effect on purpose: the once-registered click
  // listener calls it, so its identity must already exist here and every
  // value it reads must be stable — hence orgIdRef instead of the orgId
  // state (which is still null when the map is created) and loadAreasRef.
  //
  // Unlike finishArea, a plant saves on the SINGLE click: no finish step, no
  // minimum vertex count. The saved row is an estimate_areas row with
  // kind="point", a ONE-coordinate polygon, area_sqft 0, and a snapshot of
  // the chosen size in meta — createEstimateArea accepts it unchanged, which
  // was the entire point of the phase-1 migration.
  //
  // NOT in the undo stack: history/future hold draft vertex arrays, and a
  // saved plant is not a draft. Deleting the plant is the undo.
  const placePlant = useCallback(
    async (sel: { product: PlantProduct; size: PlantSize }, at: LatLng): Promise<void> => {
      // Double-place guard: a slow save plus an impatient second tap must not
      // create two plants. placingSaveRef is a useRef for exactly the reason in
      // its declaration — state would lose the race.
      if (placingSaveRef.current) return;
      placingSaveRef.current = true;
      try {
        if (!orgIdRef.current) {
          setErrorMsg("Still loading this estimate — try again in a moment.");
          return;
        }
        const { error } = await createEstimateArea(supabase, {
          estimate_id: estimateId,
          organization_id: orgIdRef.current,
          name: sel.product.name,
          color: sel.product.color,
          polygon: [at], // ONE coordinate — this is what makes it a point
          area_sqft: 0,
          kind: "point",
          // Snapshot, not just ids: re-pricing the catalogue must not silently
          // change what a customer was quoted (see plantProducts.ts).
          meta: plantSnapshot(sel.product, sel.size) as unknown as Record<string, unknown>,
        });
        // Release the guard BEFORE the reload+sync: the guard exists for the
        // write, and the marker for this plant is already visible once
        // loadAreas resolves. Holding it through syncEstimateTotals would
        // silently swallow the next tap while totals were still syncing —
        // exactly the back-to-back tapping placement mode is for.
        placingSaveRef.current = false;
        if (error) {
          setErrorMsg(`Place plant: ${error}`);
          return;
        }
        setErrorMsg(null);
        toast.success(`${sel.product.name} placed`);
        // Reload + sync exactly as finishArea does — loadAreas publishes the
        // whole array upward via onAreasChange, which is what makes the legend
        // and the labor panel update with NO legend code in this file.
        const fresh = await loadAreasRef.current();
        const syncErr = await syncEstimateTotals(supabase, estimateId, fresh);
        if (syncErr) setErrorMsg(syncErr);
      } finally {
        placingSaveRef.current = false;
      }
    },
    [estimateId, supabase, toast]
  );
  // The listener reads the LATEST placePlant through this ref — same pattern
  // as draftRef/placingRef, and it keeps the listener from capturing the
  // first render's closure.
  const placePlantRef = useRef(placePlant);
  useEffect(() => {
    placePlantRef.current = placePlant;
  }, [placePlant]);

  useEffect(() => {
    (async () => {
      await loadAreas();
      const { data, error } = await supabase
        .from("estimates")
        .select("organization_id")
        .eq("id", estimateId)
        .single();
      if (error) {
        setErrorMsg(`Org fetch: ${error.message}`);
        return;
      }
      setOrgId((data as { organization_id: string } | null)?.organization_id ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateId]);
  /* ---------- Centre the map, geocoding only as a last resort ----------
     A geocode is a BILLED request and this component mounts every time the
     estimator is opened, so geocoding on mount charged for the same answer
     over and over — "if a person keeps going in and out of the estimator".

     Areas already drawn are the better source anyway: their coordinates come
     from our own database, they are already loaded, and they frame the actual
     work rather than the postal address. After the first measurement that is
     always the path taken, so a revisit costs nothing.

     Waits for `loadingAreas` to settle. Without that the areas query could
     still be in flight, this would see an empty list and geocode a property
     that is already measured — the exact charge it exists to avoid. */
  useEffect(() => {
    if (!mapReady || centeredRef.current || loadingAreas) return;
    const map = mapRef.current;
    if (!map) return;

    const pts = areas.flatMap((a) => (Array.isArray(a.polygon) ? a.polygon : []));
    if (pts.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      pts.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds);
      centeredRef.current = true;
      return;
    }

    // Nothing measured yet: this is the one case worth paying for.
    if (!address) return;
    centeredRef.current = true; // set BEFORE the async call so a re-render
                                // mid-flight cannot fire a second geocode
    new google.maps.Geocoder().geocode({ address }, (results, status) => {
      if (status === "OK" && results && results[0]) {
        map.setCenter(results[0].geometry.location);
        new google.maps.Marker({
          position: results[0].geometry.location,
          map,
          title: address ?? undefined,
        });
      }
    });
  }, [mapReady, loadingAreas, areas, address]);



  /* ---------- Load priced services ---------- */
  useEffect(() => {
    if (!orgId) return;
    listPricedServices(supabase, orgId).then(({ data }) => setPricedServices(data));
  }, [orgId, supabase]);

  /* ---------- Load the plant catalogue (once per org) ---------- */
  // Same shape as pricedServices above. Sizes arrive already ordered by
  // sort_order — do NOT re-sort them.
  useEffect(() => {
    if (!orgId) return;
    listPlantCatalogue(supabase, orgId).then(({ data }) => {
      setPlantCatalogue(data);
      setCatalogueLoaded(true);
    });
  }, [orgId, supabase]);

  /* ---------- Load Google Maps + create the map ONCE ---------- */
  useEffect(() => {
    if (mapRef.current) return;
    let cancelled = false;

    const initMap = async () => {
      try {
        const g = await loadGoogleMaps();
        if (cancelled || !mapDivRef.current || mapRef.current) return;
        const map = new g.maps.Map(mapDivRef.current, {
          center: FALLBACK_CENTER,
          zoom: 18,
          mapTypeId: "hybrid",
          // The workspace itself is the fullscreen surface now, and the map's
          // own type/fullscreen controls sit exactly where the floating bar
          // does. Off with both; zoom + street view keep their defaults.
          fullscreenControl: false,
          mapTypeControl: false,
        });
        mapRef.current = map;

        // Centring is NOT done here — see the effect below. Geocoding is a
        // billed request, and this effect runs on every mount, so geocoding
        // from here charged for an answer we usually already have.
        setMapReady(true);

        // Registered once — reads the LATEST draft via draftRef, so it never
        // goes stale and the map never needs to be recreated when the user
        // draws (recreating it on every vertex change was the previous bug:
        // it flickered the map and re-geocoded on every click).
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          // PLACEMENT branches first and returns: while a species+size is
          // armed, a map click places a plant and must never also touch the
          // draft. placingRef mirrors the state for the same reason draftRef
          // does — this listener is registered once and must never read a
          // stale closure.
          const place = placingRef.current;
          if (place && e.latLng) {
            void placePlantRef.current(place, { lat: e.latLng.lat(), lng: e.latLng.lng() });
            return;
          }
          const cur = draftRef.current;
          if (!cur || !e.latLng) return;
          const clicked: LatLng = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          setHistory((h) => [...h, cur.vertices]);
          setFuture([]);

          // Clicking ON the outline inserts a point there; clicking away from
          // it extends the run. Appending unconditionally is what made going
          // back to add detail throw the point onto the end of the path, so the
          // outline shot across the yard to reach it.
          //
          // Tolerance is ~14 screen pixels converted to metres for the current
          // zoom, so the grab feels the same close in as zoomed out. The Web
          // Mercator ground resolution narrows by cos(lat), which is why the
          // latitude term is here as well as inside edgeHitAt.
          const zoom = mapRef.current?.getZoom() ?? 20;
          const mPerPx =
            (156543.03392 * Math.cos((clicked.lat * Math.PI) / 180)) / Math.pow(2, zoom);
          const hit = edgeHitAt(clicked, cur.vertices, 14 * mPerPx);

          setDraft(
            hit
              ? {
                  ...cur,
                  vertices: [
                    ...cur.vertices.slice(0, hit.index),
                    hit.point,
                    ...cur.vertices.slice(hit.index),
                  ],
                }
              : { ...cur, vertices: [...cur.vertices, clicked] }
          );
        });
      } catch (err) {
        if (!cancelled) setErrorMsg(`Google Maps load: ${errMessage(err)}`);
      }
    };
    initMap();
    return () => {
      cancelled = true;
    };
  }, [address]);

  /* ---------- Render static polygons for saved areas (skip the one being edited) ---------- */
  useEffect(() => {
    if (!mapRef.current) return;
    const g = google;
    staticPolygonsRef.current.forEach((p) => p.setMap(null));
    staticPolygonsRef.current = [];

    const editingId = draft && draft.areaId !== "new" ? draft.areaId : null;
    const newPolygons: google.maps.Polygon[] = [];
    areas
      .filter(
        (a) =>
          a.kind === "area" &&
          a.id !== editingId &&
          Array.isArray(a.polygon) &&
          a.polygon.length >= 3
      )
      .forEach((area) => {
        const path = area.polygon.map((p) => new g.maps.LatLng(p.lat, p.lng));
        const poly = new g.maps.Polygon({
          paths: path,
          strokeColor: area.color,
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: area.color,
          fillOpacity: 0.3,
          clickable: false,
          map: mapRef.current,
        });
        newPolygons.push(poly);
      });
    staticPolygonsRef.current = newPolygons;
  }, [areas, draft]);

  /* ---------- Render plant markers (kind="point") ---------- */
  // A placed plant is a one-coordinate estimate_areas row; its marker is how
  // the plant gets inspected and deleted, so unlike the polygons it MUST be
  // clickable. Selected plants scale up slightly. Teardown-then-rebuild, same
  // shape as the static-polygon effect above — plants reload wholesale after
  // every place/edit/delete, and rebuilding beats diffing.
  useEffect(() => {
    if (!mapRef.current) return;
    const g = google;
    plantMarkersRef.current.forEach((m) => {
      g.maps.event.clearInstanceListeners(m);
      m.setMap(null);
    });
    plantMarkersRef.current = [];

    const markers: google.maps.Marker[] = [];
    areas
      // NOT `kind === "point"`. A sprinkler head is a point too, so filtering
      // on geometry alone would draw heads as plants and open the plant card
      // on them. `kind` says what SHAPE a row is; `meta` says what it IS, and
      // isPlantArea reads the meta.
      .filter((a) => isPlantArea(a))
      .forEach((area) => {
        const at = Array.isArray(area.polygon) ? area.polygon[0] : null;
        if (!at) return;
        const selected = area.id === selectedPlantId;
        const marker = new g.maps.Marker({
          position: new g.maps.LatLng(at.lat, at.lng),
          map: mapRef.current,
          clickable: true,
          cursor: "pointer",
          zIndex: 1200, // above the vertex handles so a plant on a vertex still wins
          title: area.name,
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: selected ? 11 : 8,
            fillColor: area.color,
            fillOpacity: 1,
            strokeColor: "#ffffff", // reads on satellite imagery
            strokeWeight: 2,
          },
        });
        marker.addListener("click", () => setSelectedPlantId(area.id));
        markers.push(marker);
      });
    plantMarkersRef.current = markers;
  }, [areas, selectedPlantId]);

  /* ---------- Render draft polygon and markers ---------- */
  useEffect(() => {
    if (!mapRef.current) {
      return;
    }
    const g = google;

    vertexMarkersRef.current.forEach((m) => {
      g.maps.event.clearInstanceListeners(m);
      m.setMap(null);
    });
    midMarkersRef.current.forEach((m) => {
      g.maps.event.clearInstanceListeners(m);
      m.setMap(null);
    });
    draftPolygonRef.current?.setMap(null);
    draftPolygonRef.current = null;
    vertexMarkersRef.current = [];
    midMarkersRef.current = [];

    if (!draft) return;

    const draftColor =
      draft.areaId !== "new"
        ? areas.find((a) => a.id === draft.areaId)?.color ?? nextAreaColor([])
        : nextAreaColor(areas.filter((a) => a.kind === "area").map((a) => a.color));

    const verts = draft.vertices;
    if (verts.length >= 2) {
      const path = verts.map((v) => new g.maps.LatLng(v.lat, v.lng));
      draftPolygonRef.current = new g.maps.Polygon({
        paths: path,
        strokeColor: draftColor,
        strokeOpacity: 1,
        strokeWeight: 3,
        fillColor: draftColor,
        fillOpacity: verts.length >= 3 ? 0.35 : 0,
        clickable: false, // taps inside the shape still drop new vertices
        map: mapRef.current,
      });
    }

    const vMarkers: google.maps.Marker[] = [];
    verts.forEach((v, idx) => {
      const marker = new g.maps.Marker({
        position: new g.maps.LatLng(v.lat, v.lng),
        map: mapRef.current,
        draggable: true,
        cursor: "move",
        zIndex: 1000 + idx,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: draftColor,
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });

      marker.addListener("dragstart", () => {
        const cur = draftRef.current;
        if (cur) setHistory((h) => [...h, cur.vertices]);
        setFuture([]);
      });
      marker.addListener("dragend", (e: google.maps.MapMouseEvent) => {
        const pos = e.latLng;
        if (!pos) return;
        const moved = { lat: pos.lat(), lng: pos.lng() };
        setDraft((old) =>
          old ? { ...old, vertices: old.vertices.map((p, i) => (i === idx ? moved : p)) } : old
        );
      });
      marker.addListener("dblclick", () => {
        const cur = draftRef.current;
        if (cur) setHistory((h) => [...h, cur.vertices]);
        setFuture([]);
        setDraft((old) => (old ? { ...old, vertices: old.vertices.filter((_, i) => i !== idx) } : old));
      });

      vMarkers.push(marker);
    });
    vertexMarkersRef.current = vMarkers;

    const midMarkers: google.maps.Marker[] = [];
    if (verts.length >= 2) {
      const edgeCount = verts.length >= 3 ? verts.length : 1;
      for (let i = 0; i < edgeCount; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
        const insertAt = i + 1;
        const marker = new g.maps.Marker({
          position: new g.maps.LatLng(mid.lat, mid.lng),
          map: mapRef.current,
          zIndex: 500 + i,
          title: "Tap to add a point here",
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: draftColor,
            fillOpacity: 0.5,
            strokeColor: "#ffffff",
            strokeWeight: 1,
          },
        });
        marker.addListener("click", () => {
          const cur = draftRef.current;
          if (!cur) return;
          setHistory((h) => [...h, cur.vertices]);
          setFuture([]);
          setDraft((old) => {
            if (!old) return old;
            const next = [...old.vertices];
            next.splice(insertAt, 0, mid);
            return { ...old, vertices: next };
          });
        });
        midMarkers.push(marker);
      }
    }
    midMarkersRef.current = midMarkers;
  }, [draft, areas]);

  /* ---------- Undo / Redo ---------- */
  const undo = () => {
    if (!draft || history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [...f, draft.vertices]);
    setDraft({ ...draft, vertices: prev });
  };
  const redo = () => {
    if (!draft || future.length === 0) return;
    const next = future[future.length - 1];
    setFuture((f) => f.slice(0, -1));
    setHistory((h) => [...h, draft.vertices]);
    setDraft({ ...draft, vertices: next });
  };

  /* ---------- Toggle tag ---------- */
  const toggleTag = (tag: string) => {
    setDraft((old) => {
      if (!old) return old;
      const has = old.tags.includes(tag);
      return {
        ...old,
        tags: has ? old.tags.filter((t) => t !== tag) : [...old.tags, tag],
      };
    });
  };

  /* ---------- Finish / Cancel ---------- */
  const finishArea = async () => {
    if (!draft || draft.vertices.length < 3) return;
    const area_sqft = areaSqftFromPoints(draft.vertices);

    if (draft.areaId === "new") {
      if (!orgId) {
        setErrorMsg("Still loading this estimate — try again in a moment.");
        return;
      }
      const { error } = await createEstimateArea(supabase, {
        estimate_id: estimateId,
        organization_id: orgId,
        name: `Area ${areas.filter((a) => a.kind === "area").length + 1}`,
        color: nextAreaColor(areas.filter((a) => a.kind === "area").map((a) => a.color)),
        polygon: draft.vertices,
        area_sqft,
        access_tags: draft.tags,
      });
      if (error) {
        setErrorMsg(`Create area: ${error}`);
        return;
      }
    } else {
      const error = await updateEstimateArea(supabase, draft.areaId, {
        polygon: draft.vertices,
        area_sqft,
        access_tags: draft.tags,
      });
      if (error) {
        setErrorMsg(`Update area: ${error}`);
        return;
      }
    }

    setErrorMsg(null);
    toast.success(draft.areaId === "new" ? "Area saved" : "Area updated");
    const fresh = await loadAreas();
    const syncErr = await syncEstimateTotals(supabase, estimateId, fresh);
    if (syncErr) setErrorMsg(syncErr);
    setDraft(null);
    setHistory([]);
    setFuture([]);
  };

  const discardDraftOk = () => !draft || draft.vertices.length === 0 || confirm("Discard the unsaved area you're drawing?");

  const cancelDraft = () => {
    if (!draft || !discardDraftOk()) return;
    setDraft(null);
    setHistory([]);
    setFuture([]);
  };

  const startNewArea = () => {
    setPlacing(null); // the two modes are mutually exclusive — see startPlacement
    if (!discardDraftOk()) return;
    setDraft({ areaId: "new", vertices: [], tags: [] });
    setHistory([]);
    setFuture([]);
  };

  /* ---------- Edit existing area ---------- */
  const editArea = (area: EstimateArea) => {
    setPlacing(null); // the two modes are mutually exclusive — see startPlacement
    if (!discardDraftOk()) return;
    const polygon = Array.isArray(area.polygon) ? area.polygon : [];
    setDraft({ areaId: area.id, vertices: polygon, tags: area.access_tags ?? [] });
    setHistory([]);
    setFuture([]);

    if (mapRef.current && polygon.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      polygon.forEach((p) => bounds.extend(p));
      mapRef.current.fitBounds(bounds);
    }
  };

  /* ---------- Plant placement mode ---------- */
  // Entering placement while an unsaved draft exists would let one click mean
  // two things, so the same discardDraftOk() guard that protects "new area"
  // protects this too. And the reverse edge is handled in startNewArea /
  // editArea above: placing must never be non-null while a draft is.
  const startPlacement = (product: PlantProduct, size: PlantSize) => {
    if (!discardDraftOk()) return;
    setDraft(null);
    setHistory([]);
    setFuture([]);
    setSelectedPlantId("");
    setPlacing({ product, size });
  };

  // STICKY by design: the real job is "put in twenty hollies", and a mode
  // that exits after each plant makes that twenty round trips. Exit is
  // explicit — Done button, Escape, or arming a different size.
  const stopPlacing = () => setPlacing(null);

  /* ---------- Per-placement note ---------- */
  // Read-modify-write the WHOLE meta object: constructing a fresh one here
  // would drop the snapshot fields (price, size, ids) the legend and the
  // labor math read. Only `note` changes.
  async function savePlantNote(area: EstimateArea, raw: string) {
    const note = raw.trim();
    const current = (area.meta ?? {}) as Record<string, unknown>;
    if (note === (typeof current.note === "string" ? current.note : "")) return;
    const meta: Record<string, unknown> = { ...current };
    if (note) meta.note = note;
    else delete meta.note;
    const error = await updateEstimateArea(supabase, area.id, { meta });
    if (error) {
      setErrorMsg(`Note update: ${error}`);
      return;
    }
    setErrorMsg(null);
    await loadAreas();
  }

  /* ---------- Delete area ---------- */
  const deleteArea = async (area: EstimateArea) => {
    if (!confirm(`Delete ${area.name}?`)) return;
    const error = await deleteEstimateArea(supabase, area.id);
    if (error) {
      setErrorMsg(`Delete: ${error}`);
      return;
    }
    setErrorMsg(null);
    toast.success(`${area.name} deleted`);
    const fresh = await loadAreas();
    const syncErr = await syncEstimateTotals(supabase, estimateId, fresh);
    if (syncErr) setErrorMsg(syncErr);
    if (draft?.areaId === area.id) {
      setDraft(null);
      setHistory([]);
      setFuture([]);
    }
    if (selectedPlantId === area.id) setSelectedPlantId("");
  };

  /* ---------- Color cycle ---------- */
  const cycleColor = async (area: EstimateArea) => {
    const at = (AREA_COLORS as readonly string[]).indexOf(area.color);
    const color = AREA_COLORS[(at + 1) % AREA_COLORS.length];
    const error = await updateEstimateArea(supabase, area.id, { color });
    if (error) {
      setErrorMsg(`Color update: ${error}`);
      return;
    }
    await loadAreas();
  };

  /* ---------- Inline name edit ---------- */
  const onNameBlur = async (area: EstimateArea, raw: string) => {
    const name = raw.trim();
    if (!name || name === area.name) {
      setEditName((n) => {
        const rest = { ...n };
        delete rest[area.id];
        return rest;
      });
      return;
    }
    const error = await updateEstimateArea(supabase, area.id, { name });
    if (error) {
      setErrorMsg(`Name update: ${error}`);
      return;
    }
    setEditName((n) => {
      const rest = { ...n };
      delete rest[area.id];
      return rest;
    });
    await loadAreas();
  };

  /* ---------- Escape key ---------- */
  // TWO Escape behaviours, in priority order: if placement mode is armed,
  // Escape ends it (placement is sticky, so it needs an explicit exit — see
  // stopPlacing). Otherwise, if the panel is open, fold it. The listener is
  // registered even when the panel is closed because placement can be armed
  // with the panel folded away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (placingRef.current) {
        setPlacing(null);
        return;
      }
      if (panelOpen) setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, setPanelOpen]);

  /* ---------- Render ---------- */
  // While editing an existing (already-saved) area, drop its stored sqft
  // from the running total so the live draft figure replaces it instead of
  // being added on top of it.
  const editingId = draft && draft.areaId !== "new" ? draft.areaId : null;
  // `areas` holds TWO geometries now. Everything that meant "a measured
  // polygon" has to say so: a placed plant is a kind="point" row in the same
  // table, and counting it as an area makes the sqft list, the area numbering
  // and the colour palette all wrong.
  const polygonAreas = areas.filter((a) => a.kind === "area");
  // Anything that means "a measured polygon" reads polygonAreas — a placed
  // plant is kind="point" in this same array and must never be counted here.
  const savedSqft = totalAreaSqft(polygonAreas.filter((a) => a.id !== editingId));
  const selectedPlant = selectedPlantId
    ? areas.find((a) => a.id === selectedPlantId) ?? null
    : null;
  const selectedSnapshot = selectedPlant ? readPlantSnapshot(selectedPlant) : null;
  const draftSqft = draft ? areaSqftFromPoints(draft.vertices) : 0;
  const totalSqft = savedSqft + draftSqft;

  // Shared panel body — identical content whether the panel renders as the
  // desktop docked column or the phone bottom sheet.
  const panelBody = (
    <>
        {loadingAreas && polygonAreas.length === 0 && (
          <p className="text-sm text-gray-500">Loading areas…</p>
        )}
        {errorMsg && <p className="text-sm text-red-600">{errorMsg}</p>}

        {!draft && (
          <button
            type="button"
            onClick={startNewArea}
            className="w-full rounded bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            + New area
          </button>
        )}

        {/* ---- Plant placement (species → size → tap the map) ---- */}
        {/* The empty state matters more than the picker: a brand-new org has
            no plants and the catalogue starts empty for everyone. Same shape
            as the "No service has a $/sq ft rate yet" note below. */}
        {catalogueLoaded && plantCatalogue.length === 0 && !draft && (
          <div className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-900">
              No plants in the catalogue yet
            </p>
            <p className="text-xs text-amber-800">
              Plants are placed on the map straight from your catalogue. Add the
              species and sizes you sell first.
            </p>
            <a
              href="/lawn/plants"
              className="inline-block text-xs font-medium text-amber-900 underline"
            >
              Go to Plants
            </a>
          </div>
        )}

        {catalogueLoaded && plantCatalogue.length > 0 && !draft && (
          <div className="space-y-2 rounded border border-gray-200/70 bg-white/50 p-2">
            <p className="text-xs font-medium text-gray-700">Plants</p>
            {placing ? (
              <div className="space-y-2">
                <p className="text-xs text-gray-600">
                  Placing{" "}
                  <span className="font-medium text-gray-900">{placing.product.name}</span>{" "}
                  ({placing.size.size}) at {formatMoney(placing.size.unit_price)} each. Tap the
                  map to place one — the mode stays armed for the next.
                </p>
                <button
                  type="button"
                  onClick={stopPlacing}
                  className="w-full rounded bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-700"
                >
                  Done placing
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select
                  value={pickerProductId}
                  onChange={(e) => {
                    setPickerProductId(e.target.value);
                    setPickerSizeId("");
                  }}
                  aria-label="Plant species"
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="">Species…</option>
                  {plantCatalogue.map((p) => (
                    // A species with NO sizes cannot be placed — no price, no
                    // install time. Disabled with why, not hidden.
                    <option key={p.id} value={p.id} disabled={p.sizes.length === 0}>
                      {p.name}
                      {p.sizes.length === 0 ? " (no sizes yet)" : ""}
                    </option>
                  ))}
                </select>
                <select
                  value={pickerSizeId}
                  onChange={(e) => {
                    const sizeId = e.target.value;
                    setPickerSizeId(sizeId);
                    const product = plantCatalogue.find((p) => p.id === pickerProductId);
                    const size = product?.sizes.find((s) => s.id === sizeId);
                    if (product && size) startPlacement(product, size);
                  }}
                  disabled={!pickerProductId}
                  aria-label="Plant size"
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-40"
                >
                  <option value="">Size…</option>
                  {(plantCatalogue.find((p) => p.id === pickerProductId)?.sizes ?? []).map(
                    (s) => (
                      <option key={s.id} value={s.id}>
                        {`${s.size} — ${formatMoney(s.unit_price)}`}
                      </option>
                    )
                  )}
                </select>
              </div>
            )}
          </div>
        )}

        {draft && (
          <div className="space-y-2 rounded border border-gray-200/70 bg-white/50 p-2">
            <div className="text-sm font-medium text-gray-900">
              {draftSqft.toLocaleString()} sq ft
            </div>
            <p className="text-xs text-gray-500">
              Tap the map to add points. Drag a dot to move it, tap a small dot on an edge to add
              one, double-click a dot to delete it.
            </p>
            <p className="text-xs text-gray-500">
              Access / obstacles (tap any that apply):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ACCESS_TAG_PRESETS.map((tag) => {
                const active = draft.tags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={
                      active
                        ? "rounded-full bg-amber-600 px-2.5 py-1 text-xs font-medium text-white"
                        : "rounded-full border border-gray-300 px-2.5 py-1 text-xs text-gray-600"
                    }
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={undo}
                disabled={history.length === 0}
                className="rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={future.length === 0}
                className="rounded border border-gray-300 px-3 py-2 text-sm disabled:opacity-40"
              >
                Redo
              </button>
              <button
                type="button"
                onClick={finishArea}
                disabled={draft.vertices.length < 3}
                className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Finish area
              </button>
              <button
                type="button"
                onClick={cancelDraft}
                className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {!loadingAreas && polygonAreas.length === 0 && !draft && (
          <p className="text-sm text-gray-500">
            No areas yet. Tap &ldquo;+ New area&rdquo;, then tap the map to trace the lawn.
          </p>
        )}

        {polygonAreas.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {polygonAreas.map((area) => (
              <li key={area.id} className="flex flex-wrap items-center gap-2 py-2">
                <button
                  type="button"
                  onClick={() => cycleColor(area)}
                  title="Change color"
                  aria-label={`Change color of ${area.name}`}
                  className="h-7 w-7 shrink-0 rounded border border-gray-300"
                  style={{ backgroundColor: area.color }}
                />
                <input
                  type="text"
                  value={editName[area.id] ?? area.name}
                  onChange={(e) => setEditName((n) => ({ ...n, [area.id]: e.target.value }))}
                  onBlur={(e) => onNameBlur(area, e.target.value)}
                  aria-label="Area name"
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                />
                <span className="shrink-0 text-sm tabular-nums text-gray-700">
                  {area.area_sqft.toLocaleString()} sq ft
                </span>
                <button
                  type="button"
                  onClick={() => editArea(area)}
                  className="shrink-0 rounded border border-gray-300 px-2 py-1 text-sm text-gray-700"
                >
                  Edit shape
                </button>
                <button
                  type="button"
                  onClick={() => deleteArea(area)}
                  className="shrink-0 rounded border border-red-200 px-2 py-1 text-sm text-red-600"
                >
                  Delete
                </button>
                {/* Pricing lives ON the area, not in a panel with an area
                    dropdown. With several areas that dropdown was a way to
                    price the wrong one by accident: you finished a shape, then
                    had to find it again in a list. Starting from the row means
                    the area is never ambiguous. selectedAreaId now means
                    "which row is open" — one at a time, by construction. */}
                {pricedServices.length > 0 &&
                  (selectedAreaId === area.id ? (
                    <div className="flex w-full flex-col gap-2 pl-9">
                      <select
                        value={selectedServiceId}
                        onChange={(e) => setSelectedServiceId(e.target.value)}
                        aria-label={`Service for ${area.name}`}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        <option value="">Select service…</option>
                        {pricedServices.map((s) => (
                          <option key={s.id} value={s.id}>
                            {`${s.name} ($${s.price_per_sqft}/sq ft)`}
                          </option>
                        ))}
                      </select>
                      {(() => {
                        // Resolved once: the price shown and the price added
                        // must come from the same lookup or they could drift.
                        const svc = pricedServices.find((x) => x.id === selectedServiceId);
                        if (!svc) return null;
                        const price = sqftPrice(area.area_sqft, svc.price_per_sqft);
                        return (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium tabular-nums text-gray-900">
                              {formatMoney(price)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                onAddLineItem({
                                  description: `${svc.name} — ${area.name}`,
                                  quantity: 1,
                                  unit: "LOT",
                                  unit_price: price,
                                });
                                toast.success("Line item added");
                                setSelectedAreaId("");
                                setSelectedServiceId("");
                              }}
                              className="shrink-0 rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700"
                            >
                              Add to estimate
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAreaId(area.id);
                        setSelectedServiceId("");
                      }}
                      className="shrink-0 rounded border border-gray-300 px-2 py-1 text-sm text-gray-700"
                    >
                      Price
                    </button>
                  ))}
                {area.access_tags.length > 0 && (
                  <div className="flex w-full flex-wrap gap-1 pl-9">
                    {area.access_tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* ---- Selected placed plant: inspect / note / delete ---- */}
        {/* Clicking a marker sets selectedPlantId; this card is the whole
            inspection surface. Deleting is the plant's undo — saved plants
            are deliberately not in the draft undo stack. */}
        {selectedPlant && (
          <div className="space-y-2 rounded border border-gray-200/70 bg-white/50 p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">
                  {selectedPlant.name}
                </p>
                {selectedSnapshot ? (
                  <p className="text-xs text-gray-500">
                    {selectedSnapshot.size} · {formatMoney(selectedSnapshot.unit_price)} each ·{" "}
                    {selectedSnapshot.install_minutes > 0
                      ? `${selectedSnapshot.install_minutes} man-min install`
                      : "install time not estimated"}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">Placed point</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedPlantId("")}
                title="Close"
                aria-label="Close plant card"
                className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {selectedSnapshot && (
              <input
                type="text"
                // Per-placement note ("specimen, face the street"), distinct
                // from the species' own notes. Saved on blur.
                value={plantNote[selectedPlant.id] ?? selectedSnapshot.note ?? ""}
                onChange={(e) =>
                  setPlantNote((n) => ({ ...n, [selectedPlant.id]: e.target.value }))
                }
                onBlur={(e) => void savePlantNote(selectedPlant, e.target.value)}
                placeholder="Note for this placement (optional)"
                aria-label="Placement note"
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
              />
            )}
            <button
              type="button"
              onClick={() => void deleteArea(selectedPlant)}
              className="w-full rounded border border-red-200 px-2 py-1 text-sm text-red-600"
            >
              Delete plant
            </button>
          </div>
        )}

        {/* No service carries a $/sq ft rate, so there is nothing to price
            against. This used to render NOTHING — the pricing panel simply
            vanished, with no way to tell whether area pricing did not exist,
            was broken, or was hidden. The rate is an optional field on each
            service, which is not somewhere you would think to look. */}
        {polygonAreas.length > 0 && pricedServices.length === 0 && (
          <div className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-900">
              No service has a $/sq ft rate yet
            </p>
            <p className="text-xs text-amber-800">
              Measured areas can only be priced against a service that has one.
              Open a service and fill in &ldquo;$ per sq ft&rdquo;.
            </p>
            <a
              href="/lawn/services"
              className="inline-block text-xs font-medium text-amber-900 underline"
            >
              Go to Services
            </a>
          </div>
        )}


      {panelSlot}
    </>
  );

  return (
    <div className="relative h-full w-full">
      {/* The canvas IS the surface: the map fills the whole container and
          every control floats over it — nothing stacked above, nothing
          beside. The parent must give this a definite height (the workspace
          shell is h-dvh). */}
      <div className="absolute inset-0">
        <div ref={mapDivRef} className="h-full w-full" />
      </div>

      {/* Folded-away pill — the floating tab. Phone: bottom-centre over the
          map. Desktop: the dock's home position, top-left. Tapping it opens
          the panel; the map stays full behind it either way. */}
      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-gray-200 bg-white/95 py-2 pl-3 shadow-lg backdrop-blur lg:bottom-auto lg:left-3 lg:top-3 lg:translate-x-0"
        >
          <Ruler className="h-4 w-4 shrink-0 text-green-700" />
          <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-gray-900">
            {totalSqft.toLocaleString()} sq ft
          </span>
          <span className="whitespace-nowrap text-xs text-gray-500">
            {polygonAreas.length} {polygonAreas.length === 1 ? "area" : "areas"}
          </span>
          {panelBadge}
          <ChevronUp className="h-4 w-4 shrink-0 text-gray-500" />
        </button>
      )}

      {/* Desktop docked column floating over the map's left edge. The map
          runs underneath it — the panel does not displace the canvas. */}
      {isDesktop && panelOpen && (
        <aside className="absolute left-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-96 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-white/60 bg-white/85 shadow-lg ring-1 ring-black/5 backdrop-blur-md">
          <div className="flex items-start justify-between gap-2 border-b border-gray-100 p-3">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                {totalSqft.toLocaleString()} sq ft
              </h2>
              <p className="text-xs text-gray-500">
                {polygonAreas.length} {polygonAreas.length === 1 ? "area" : "areas"} measured
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              title="Hide panel"
              className="shrink-0 rounded border border-gray-300 p-2 text-gray-600 hover:bg-gray-50"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 space-y-3 overflow-y-auto p-3">{panelBody}</div>
        </aside>
      )}

      {/* Phone bottom sheet — overlays the map instead of displacing it.
          Folds to the pill above so the map owns the screen; only this sheet
          scrolls internally. */}
      {!isDesktop && panelOpen && (
        <aside className="absolute inset-x-2 bottom-2 z-10 flex max-h-[62dvh] flex-col overflow-hidden rounded-xl border border-white/60 bg-white/85 shadow-xl ring-1 ring-black/5 backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <p className="text-sm font-semibold tabular-nums text-gray-900">
              {totalSqft.toLocaleString()} sq ft
              <span className="ml-1.5 text-xs font-normal text-gray-500">
                · {polygonAreas.length} {polygonAreas.length === 1 ? "area" : "areas"}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              title="Hide panel"
              className="shrink-0 rounded p-1.5 text-gray-500 hover:bg-gray-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 space-y-3 overflow-y-auto p-3">{panelBody}</div>
        </aside>
      )}
    </div>
  );
}
