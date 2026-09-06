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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  adjustedRadius,
  coverageReport,
  coverageRing,
  describeAdjustment,
  describeCoverage,
  describeThrow,
  HEAD_ARCS,
  headSnapshot,
  headsForCoverage,
  isIrrigationArea,
  listIrrigationCatalogue,
  pressureAgeDays,
  pressureUntested,
  pressureVerdict,
  readHeadSnapshot,
  readPressureTest,
  type HeadArc,
  type IrrigationNozzle,
  type IrrigationProduct,
  type IrrigationWithNozzles,
  type PressureTest,
} from "@/lib/irrigationProducts";
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
  // Per-placement note drafts, keyed by area id — mirrors editName. Heads
  // reuse the same map: a note is a note, whatever the point is.
  const [plantNote, setPlantNote] = useState<{ [id: string]: string }>({});
  const [selectedAreaId, setSelectedAreaId] = useState<string>("");
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");

  /* ---------- Sprinkler heads (Lane B) ---------- */
  // The head catalogue, same shape as the plant catalogue: models ordered by
  // name, nozzles already ordered by sort_order (never alphabetical).
  const [headCatalogue, setHeadCatalogue] = useState<IrrigationWithNozzles[]>([]);
  const [headCatalogueLoaded, setHeadCatalogueLoaded] = useState(false);
  const [headPickerProductId, setHeadPickerProductId] = useState<string>("");
  const [headPickerNozzleId, setHeadPickerNozzleId] = useState<string>("");
  // The arc lives on the PLACEMENT, not the catalogue: the same nozzle is a 90
  // in a corner and a 360 mid-lawn. Defaults to full circle.
  const [headPickerArc, setHeadPickerArc] = useState<HeadArc>(360);
  // Head placement mode — mutually exclusive with plant placing AND with the
  // draft, exactly like plant placement (see startPlacement).
  const [placingHead, setPlacingHead] = useState<{
    product: IrrigationProduct;
    nozzle: IrrigationNozzle;
    arc: HeadArc;
  } | null>(null);
  // The selected placed head (inspect card). Empty string = none.
  const [selectedHeadId, setSelectedHeadId] = useState<string>("");
  // Coverage drawing on/off. ON by default — the drawing is the feature; the
  // toggle exists so drawing stays possible while measuring new polygons.
  const [coverageOn, setCoverageOn] = useState(true);
  // Site pressure test, read off the estimates row. The prompt for it renders
  // BEFORE layout is attempted — see the pressure section in the panel.
  const [pressure, setPressure] = useState<PressureTest | null>(null);
  const [pressureFormOpen, setPressureFormOpen] = useState(false);
  const [psiStatic, setPsiStatic] = useState("");
  const [psiWorking, setPsiWorking] = useState("");
  const [psiGpm, setPsiGpm] = useState("");
  const [psiNotes, setPsiNotes] = useState("");
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
  // Same treatment for head placement mode — one ref per mode, checked in
  // order in the click listener.
  const placingHeadRef = useRef(placingHead);
  useEffect(() => {
    placingHeadRef.current = placingHead;
  }, [placingHead]);
  // The site pressure test, mirrored for placeHead (same reason as orgIdRef:
  // the once-registered listener's callees must never read stale state).
  const pressureRef = useRef(pressure);
  useEffect(() => {
    pressureRef.current = pressure;
  }, [pressure]);
  // In-flight guard for placePlant. A ref, not state: state updates are async
  // and an impatient second tap can beat the re-render — this repo has
  // already shipped a double-submit bug from exactly that (crew/photo).
  const placingSaveRef = useRef(false);
  // Same guard for placeHead — a separate ref so the two modes never gate
  // each other's saves.
  const headSaveRef = useRef(false);
  // Placed heads (kind="point" + a head snapshot in meta). Rebuilt wholesale
  // on every areas change, same as plant markers.
  const headMarkersRef = useRef<google.maps.Marker[]>([]);
  // Coverage shapes: one Circle (360) or Polygon (part arc) per placed head
  // with a recorded throw, plus the gap markers. Teardown-then-rebuild.
  const coverageShapesRef = useRef<(google.maps.Circle | google.maps.Polygon)[]>([]);
  const gapMarkersRef = useRef<google.maps.Marker[]>([]);
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

  /* ---------- Place a sprinkler head (kind="point" + head snapshot) ----------
     Mirrors placePlant exactly: same row shape (one coordinate, area_sqft 0,
     kind="point"), a HEAD snapshot in meta instead of a plant one, the same
     in-flight guard pattern, the same reload+sync. Nothing about the row
     format is shared code — the discrimination happens on read, via meta.

     The pressure gate runs BEFORE the write: a nozzle below its minimum
     operating pressure gets the contract's blocking note and NO placement.
     adjustedRadius deliberately refuses to return a smaller circle in that
     case, and this file must not undo that by placing the head anyway. */
  const placeHead = useCallback(
    async (
      sel: { product: IrrigationProduct; nozzle: IrrigationNozzle; arc: HeadArc },
      at: LatLng
    ): Promise<void> => {
      // Double-place guard — same race, same cure as placePlant above.
      if (headSaveRef.current) return;
      headSaveRef.current = true;
      try {
        const workingPsi = pressureRef.current?.workingPsi ?? null;
        const adj = adjustedRadius(sel.nozzle, workingPsi);
        if (adj.method === "below_minimum") {
          setErrorMsg(adj.note);
          return;
        }
        if (!orgIdRef.current) {
          setErrorMsg("Still loading this estimate — try again in a moment.");
          return;
        }
        const { error } = await createEstimateArea(supabase, {
          estimate_id: estimateId,
          organization_id: orgIdRef.current,
          name: sel.product.name,
          color: sel.product.color,
          polygon: [at], // ONE coordinate — same geometry as a plant
          area_sqft: 0,
          kind: "point",
          // Snapshot, not ids: arc and heading are chosen at placement, and
          // re-pricing the catalogue must not change what was quoted.
          meta: headSnapshot(sel.product, sel.nozzle, sel.arc, 0) as unknown as Record<
            string,
            unknown
          >,
        });
        // Release the guard BEFORE the reload+sync — same reasoning as
        // placePlant: sticky placement is for back-to-back tapping.
        headSaveRef.current = false;
        if (error) {
          setErrorMsg(`Place head: ${error}`);
          return;
        }
        setErrorMsg(null);
        toast.success(`${sel.product.name} placed`);
        const fresh = await loadAreasRef.current();
        const syncErr = await syncEstimateTotals(supabase, estimateId, fresh);
        if (syncErr) setErrorMsg(syncErr);
      } finally {
        headSaveRef.current = false;
      }
    },
    [estimateId, supabase, toast]
  );
  const placeHeadRef = useRef(placeHead);
  useEffect(() => {
    placeHeadRef.current = placeHead;
  }, [placeHead]);

  /* ---------- Coverage reports (derived) ---------- */
  // One report per MEASURED POLYGON (never per point row — a head is not a
  // surface to cover), each measured against ALL placed heads. Everything
  // below renders the contract's describeCoverage lines verbatim off these;
  // nothing here invents a summary score. headsPlaced gates the whole report
  // block: with no heads there is nothing to measure against.
  const { headsPlaced, coverageReports } = useMemo(() => {
    const heads = headsForCoverage(areas);
    const reports = areas
      .filter((a) => a.kind === "area" && Array.isArray(a.polygon) && a.polygon.length >= 3)
      .map((a) => ({ areaId: a.id, report: coverageReport(a.polygon, heads) }));
    return { headsPlaced: heads.length, coverageReports: reports };
  }, [areas]);

  useEffect(() => {
    (async () => {
      await loadAreas();
      // The pressure_* columns ride along on this same read — they are per-
      // estimate site measurements, and one query beats a second round trip.
      // readPressureTest narrows them (null-safe when the columns are absent).
      const { data, error } = await supabase
        .from("estimates")
        .select(
          "organization_id, pressure_static_psi, pressure_working_psi, pressure_gpm, pressure_tested_at, pressure_notes"
        )
        .eq("id", estimateId)
        .single();
      if (error) {
        setErrorMsg(`Org fetch: ${error.message}`);
        return;
      }
      setOrgId((data as { organization_id: string } | null)?.organization_id ?? null);
      setPressure(readPressureTest(data));
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

  /* ---------- Load the head catalogue (once per org) ---------- */
  // Same shape as the plant catalogue above. Nozzles arrive ordered by
  // sort_order via listIrrigationCatalogue — do NOT re-sort them.
  useEffect(() => {
    if (!orgId) return;
    listIrrigationCatalogue(supabase, orgId).then(({ data }) => {
      setHeadCatalogue(data);
      setHeadCatalogueLoaded(true);
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
          // PLACEMENT branches first and returns: while a mode is armed, a map
          // click places one thing and must never also touch the draft.
          // Head placement is checked first only because only one mode can be
          // armed at a time (they clear each other) — the order is cosmetic.
          // placingHeadRef/placingRef mirror the state for the same reason
          // draftRef does — this listener is registered once and must never
          // read a stale closure.
          const placeHeadSel = placingHeadRef.current;
          if (placeHeadSel && e.latLng) {
            void placeHeadRef.current(placeHeadSel, { lat: e.latLng.lat(), lng: e.latLng.lng() });
            return;
          }
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
        marker.addListener("click", () => {
          setSelectedPlantId(area.id);
          setSelectedHeadId(""); // one inspect card at a time
        });
        markers.push(marker);
      });
    plantMarkersRef.current = markers;
  }, [areas, selectedPlantId]);

  /* ---------- Render head markers + coverage ---------- */
  // Two jobs in one effect because they share the teardown: every placed head
  // gets a marker (clickable, like plants) and — when coverage is on and the
  // snapshot has a throw — a coverage shape. A 360 draws google.maps.Circle;
  // a part arc draws the coverageRing polygon, which Google has no primitive
  // for. radius_ft 0 (throw not recorded) draws NOTHING — an unrecorded
  // radius must never render as a dot at the head or a zero circle.
  //
  // Markers are visually distinct from plants (white fill, coloured stroke —
  // plants are the inverse) so a head never reads as a plant on the map.
  useEffect(() => {
    if (!mapRef.current) return;
    const g = google;
    headMarkersRef.current.forEach((m) => {
      g.maps.event.clearInstanceListeners(m);
      m.setMap(null);
    });
    headMarkersRef.current = [];
    coverageShapesRef.current.forEach((s) => s.setMap(null));
    coverageShapesRef.current = [];
    gapMarkersRef.current.forEach((m) => {
      g.maps.event.clearInstanceListeners(m);
      m.setMap(null);
    });
    gapMarkersRef.current = [];

    const markers: google.maps.Marker[] = [];
    const shapes: (google.maps.Circle | google.maps.Polygon)[] = [];
    const gaps: google.maps.Marker[] = [];

    areas
      // NOT `kind === "point"`. A plant is a point too — kind says what SHAPE
      // a row is, meta says what it IS, and isIrrigationArea reads the meta.
      .filter((a) => isIrrigationArea(a))
      .forEach((area) => {
        const snap = readHeadSnapshot(area);
        const at = Array.isArray(area.polygon) ? area.polygon[0] : null;
        if (!snap || !at) return;
        const selected = area.id === selectedHeadId;
        const marker = new g.maps.Marker({
          position: new g.maps.LatLng(at.lat, at.lng),
          map: mapRef.current,
          clickable: true,
          cursor: "pointer",
          zIndex: 1200, // above the vertex handles, same tier as plant markers
          title: `${area.name} — ${snap.nozzle || "nozzle?"} · ${snap.arc_deg}°`,
          // WHITE fill with a coloured stroke — the inverse of the plant
          // marker (coloured fill, white stroke), so the two point kinds
          // never look alike on satellite imagery.
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            scale: selected ? 11 : 8,
            fillColor: "#ffffff",
            fillOpacity: 1,
            strokeColor: area.color,
            strokeWeight: 2,
          },
        });
        marker.addListener("click", () => {
          setSelectedHeadId(area.id);
          setSelectedPlantId(""); // one inspect card at a time
        });
        markers.push(marker);

        if (!coverageOn) return;
        if (!(snap.radius_ft > 0)) return; // throw not recorded — draw nothing
        const radiusM = snap.radius_ft * 0.3048; // Circle wants metres
        if (snap.arc_deg === 360) {
          shapes.push(
            new g.maps.Circle({
              center: new g.maps.LatLng(at.lat, at.lng),
              radius: radiusM,
              strokeColor: area.color,
              strokeOpacity: 0.7,
              strokeWeight: 1,
              fillColor: area.color,
              fillOpacity: 0.15,
              clickable: false,
              map: mapRef.current,
            })
          );
        } else {
          const ring = coverageRing(at, snap.radius_ft, snap.arc_deg, snap.heading_deg);
          if (ring.length < 2) return;
          shapes.push(
            new g.maps.Polygon({
              paths: ring.map((p) => new g.maps.LatLng(p.lat, p.lng)),
              strokeColor: area.color,
              strokeOpacity: 0.7,
              strokeWeight: 1,
              fillColor: area.color,
              fillOpacity: 0.15,
              clickable: false,
              map: mapRef.current,
            })
          );
        }
      });

    // Gap markers from the coverage reports — small amber dots, not clickable,
    // below everything else in z-order. Drawn only while coverage is on.
    if (coverageOn) {
      coverageReports.forEach(({ report }) =>
        report.gapPoints.forEach((p) => {
          gaps.push(
            new g.maps.Marker({
              position: new g.maps.LatLng(p.lat, p.lng),
              map: mapRef.current,
              clickable: false,
              zIndex: 300,
              icon: {
                path: g.maps.SymbolPath.CIRCLE,
                scale: 4,
                fillColor: "#b45309",
                fillOpacity: 0.9,
                strokeColor: "#ffffff",
                strokeWeight: 1,
              },
            })
          );
        })
      );
    }

    headMarkersRef.current = markers;
    coverageShapesRef.current = shapes;
    gapMarkersRef.current = gaps;
    // coverageReports is derived from areas (below), so listing it here keeps
    // the gap markers honest after every reload.
  }, [areas, selectedHeadId, coverageOn, coverageReports]);

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
    setPlacing(null); // the placement modes are mutually exclusive — see startPlacement
    setPlacingHead(null);
    if (!discardDraftOk()) return;
    setDraft({ areaId: "new", vertices: [], tags: [] });
    setHistory([]);
    setFuture([]);
  };

  /* ---------- Edit existing area ---------- */
  const editArea = (area: EstimateArea) => {
    setPlacing(null); // the placement modes are mutually exclusive — see startPlacement
    setPlacingHead(null);
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
    setPlacingHead(null); // one placement mode at a time
    setPlacing({ product, size });
  };

  // STICKY by design: the real job is "put in twenty hollies", and a mode
  // that exits after each plant makes that twenty round trips. Exit is
  // explicit — Done button, Escape, or arming a different size.
  const stopPlacing = () => setPlacing(null);

  /* ---------- Head placement mode ---------- */
  // Same discipline as plant placement: discards a draft only with consent,
  // clears the other placement mode, sticky until explicitly ended. The arc
  // can still be changed while armed — it is a property of the placement.
  const startHeadPlacement = (product: IrrigationProduct, nozzle: IrrigationNozzle) => {
    if (!discardDraftOk()) return;
    setDraft(null);
    setHistory([]);
    setFuture([]);
    setSelectedHeadId("");
    setPlacing(null); // one placement mode at a time
    setPlacingHead({ product, nozzle, arc: headPickerArc });
  };

  const stopHeadPlacing = () => setPlacingHead(null);

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

  /* ---------- Rotate a placed head ---------- */
  // Only meaningful for part circles — a 360 ignores heading, so the buttons
  // are hidden on full-circle heads. Read-modify-write the WHOLE meta, same
  // rule as savePlantNote: the snapshot fields must survive the edit.
  async function rotateHead(area: EstimateArea, delta: number) {
    const snap = readHeadSnapshot(area);
    if (!snap || snap.arc_deg === 360) return;
    const current = (area.meta ?? {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {
      ...current,
      heading_deg: (snap.heading_deg + delta + 360) % 360,
    };
    const error = await updateEstimateArea(supabase, area.id, { meta });
    if (error) {
      setErrorMsg(`Rotate head: ${error}`);
      return;
    }
    setErrorMsg(null);
    await loadAreas();
  }

  /* ---------- Site pressure test ---------- */
  // Saves the four readings + a fresh timestamp straight onto the estimate
  // row, then re-reads them through readPressureTest so the displayed state
  // is always the contract's narrow, not the raw form input.
  async function savePressureTest() {
    const numOrNull = (raw: string): number | null => {
      const t = raw.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const { error } = await supabase
      .from("estimates")
      .update({
        pressure_static_psi: numOrNull(psiStatic),
        pressure_working_psi: numOrNull(psiWorking),
        pressure_gpm: numOrNull(psiGpm),
        pressure_notes: psiNotes.trim() || null,
        pressure_tested_at: new Date().toISOString(),
      })
      .eq("id", estimateId);
    if (error) {
      setErrorMsg(`Pressure test: ${error.message}`);
      return;
    }
    setErrorMsg(null);
    toast.success("Pressure test saved");
    setPressureFormOpen(false);
    const { data } = await supabase
      .from("estimates")
      .select(
        "pressure_static_psi, pressure_working_psi, pressure_gpm, pressure_tested_at, pressure_notes"
      )
      .eq("id", estimateId)
      .single();
    setPressure(readPressureTest(data));
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
    if (selectedHeadId === area.id) setSelectedHeadId("");
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
  // Escape behaviours, in priority order: if EITHER placement mode is armed,
  // Escape ends it (placement is sticky, so it needs an explicit exit — see
  // stopPlacing / stopHeadPlacing). Otherwise, if the panel is open, fold it.
  // The listener is registered even when the panel is closed because
  // placement can be armed with the panel folded away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (placingHeadRef.current) {
        setPlacingHead(null);
        return;
      }
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
  const selectedHead = selectedHeadId
    ? areas.find((a) => a.id === selectedHeadId) ?? null
    : null;
  const selectedHeadSnap = selectedHead ? readHeadSnapshot(selectedHead) : null;
  const draftSqft = draft ? areaSqftFromPoints(draft.vertices) : 0;
  const totalSqft = savedSqft + draftSqft;

  /* ---------- Pressure + adjustment derivations for the panel ---------- */
  const pressureVerdictInfo = pressure ? pressureVerdict(pressure) : null;
  const pressureAge = pressure ? pressureAgeDays(pressure) : null;
  // The prompt shows once the estimate row has loaded (pressure !== null);
  // before that it renders nothing — flashing a prompt before the data
  // arrives reads as an error.
  const workingPsi = pressure?.workingPsi ?? null;
  // Adjustment for the currently armed head — recomputed on every render so
  // a freshly saved pressure test immediately rewrites the banner note.
  const armedAdjustment = placingHead ? adjustedRadius(placingHead.nozzle, workingPsi) : null;
  // For the selected head, adjust against the CATALOGUE nozzle when it is
  // still findable (carrying min_psi/performance if present); fall back to
  // the snapshot's own radius so a head from a since-deleted model still
  // gets an honest note instead of none.
  const selectedAdjustNozzle = selectedHeadSnap
    ? headCatalogue.find((p) => p.id === selectedHeadSnap.irrigation_product_id)?.nozzles.find(
        (n) => n.id === selectedHeadSnap.irrigation_nozzle_id
      ) ?? { radius_ft: selectedHeadSnap.radius_ft }
    : null;
  const selectedAdjustment =
    selectedHeadSnap && selectedAdjustNozzle
      ? adjustedRadius(selectedAdjustNozzle, workingPsi)
      : null;

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

        {/* ---- Site pressure test: prompted BEFORE the layout ---- */}
        {/* Every throw distance below assumes a design pressure the site may
            not deliver, so the prompt (and the verdict line, verbatim from
            the contract) renders before any head is placed, not at quote
            time. Shown for untested AND for recorded readings (the recorded
            verdict is the warning that matters); hidden while pressure has
            not loaded yet so the prompt never flashes as an error. */}
        {pressure && pressureVerdictInfo && !pressureFormOpen && (
          <div className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2">
            <p className="text-xs text-amber-900">{pressureVerdictInfo.message}</p>
            <p className="text-xs text-amber-800">
              {pressureAge === null ? "Pressure not tested" : `Pressure test ${pressureAge} days old`}
            </p>
            <button
              type="button"
              onClick={() => setPressureFormOpen(true)}
              className={
                pressureUntested(pressure)
                  ? "rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                  : "text-xs font-medium text-amber-900 underline"
              }
            >
              {pressureUntested(pressure) ? "Record a pressure test" : "Edit pressure test"}
            </button>
          </div>
        )}
        {pressureFormOpen && (
          <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-900">Site pressure test</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-amber-900">
                Static psi
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={psiStatic}
                  onChange={(e) => setPsiStatic(e.target.value)}
                  aria-label="Static pressure psi"
                  className="mt-0.5 w-full rounded border border-amber-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-amber-900">
                Working psi
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={psiWorking}
                  onChange={(e) => setPsiWorking(e.target.value)}
                  aria-label="Working pressure psi"
                  className="mt-0.5 w-full rounded border border-amber-300 px-2 py-1 text-sm"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-amber-900">
                Flow (gpm)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={psiGpm}
                  onChange={(e) => setPsiGpm(e.target.value)}
                  aria-label="Pressure test flow gpm"
                  className="mt-0.5 w-full rounded border border-amber-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-amber-900">
                Notes
                <input
                  type="text"
                  value={psiNotes}
                  onChange={(e) => setPsiNotes(e.target.value)}
                  aria-label="Pressure test notes"
                  className="mt-0.5 w-full rounded border border-amber-300 px-2 py-1 text-sm"
                />
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void savePressureTest()}
                className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
              >
                Save test
              </button>
              <button
                type="button"
                onClick={() => setPressureFormOpen(false)}
                className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-900"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ---- Sprinkler heads (model → nozzle → arc → tap the map) ---- */}
        {/* Same empty-state discipline as plants: a brand-new org has no head
            models either, and the picker must say where to fix that. */}
        {headCatalogueLoaded && headCatalogue.length === 0 && !draft && (
          <div className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2">
            <p className="text-xs font-medium text-amber-900">
              No sprinkler heads in the catalogue yet
            </p>
            <p className="text-xs text-amber-800">
              Heads are placed on the map straight from your catalogue. Add the
              models and nozzles you install first.
            </p>
            <a
              href="/lawn/irrigation"
              className="inline-block text-xs font-medium text-amber-900 underline"
            >
              Go to Heads
            </a>
          </div>
        )}

        {headCatalogueLoaded && headCatalogue.length > 0 && !draft && (
          <div className="space-y-2 rounded border border-gray-200/70 bg-white/50 p-2">
            <p className="text-xs font-medium text-gray-700">Sprinkler heads</p>
            {placingHead ? (
              <div className="space-y-2">
                <p className="text-xs text-gray-600">
                  Placing{" "}
                  <span className="font-medium text-gray-900">{placingHead.product.name}</span>{" "}
                  ({placingHead.nozzle.nozzle},{" "}
                  {placingHead.arc === 360 ? "full circle" : `${placingHead.arc}°`}) —{" "}
                  {describeThrow(placingHead.nozzle.radius_ft)}. Tap the map to place one — the
                  mode stays armed for the next.
                </p>
                {armedAdjustment && (
                  <p
                    className={
                      armedAdjustment.method === "below_minimum"
                        ? "text-xs font-medium text-red-700"
                        : "text-xs text-gray-500"
                    }
                  >
                    {describeAdjustment(armedAdjustment)}
                  </p>
                )}
                <div className="flex gap-2">
                  {/* The arc is a property of the PLACEMENT, not the part —
                      changeable while armed. */}
                  <select
                    value={headPickerArc}
                    onChange={(e) => {
                      const arc = Number(e.target.value) as HeadArc;
                      setHeadPickerArc(arc);
                      if (placingHead) setPlacingHead({ ...placingHead, arc });
                    }}
                    aria-label="Spray arc"
                    className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                  >
                    {HEAD_ARCS.map((a) => (
                      <option key={a} value={a}>
                        {a === 360 ? "360° — full circle" : `${a}°`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={stopHeadPlacing}
                    className="w-full rounded bg-green-600 py-2 text-sm font-medium text-white hover:bg-green-700"
                  >
                    Done placing
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select
                  value={headPickerProductId}
                  onChange={(e) => {
                    setHeadPickerProductId(e.target.value);
                    setHeadPickerNozzleId("");
                  }}
                  aria-label="Head model"
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="">Model…</option>
                  {headCatalogue.map((p) => (
                    // A model with NO nozzles cannot be placed — disabled
                    // with why, not hidden, same as unsized species.
                    <option key={p.id} value={p.id} disabled={p.nozzles.length === 0}>
                      {p.name}
                      {p.nozzles.length === 0 ? " (no nozzles yet)" : ""}
                    </option>
                  ))}
                </select>
                <select
                  value={headPickerNozzleId}
                  onChange={(e) => {
                    const nozzleId = e.target.value;
                    setHeadPickerNozzleId(nozzleId);
                    const product = headCatalogue.find((p) => p.id === headPickerProductId);
                    const nozzle = product?.nozzles.find((n) => n.id === nozzleId);
                    if (product && nozzle) startHeadPlacement(product, nozzle);
                  }}
                  disabled={!headPickerProductId}
                  aria-label="Head nozzle"
                  className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-40"
                >
                  <option value="">Nozzle…</option>
                  {(headCatalogue.find((p) => p.id === headPickerProductId)?.nozzles ?? []).map(
                    (n) => (
                      // describeThrow spells out BOTH numbers ("30 ft from
                      // the head · 60 ft across") so a radius/diameter
                      // mistake is visible at the moment of choosing.
                      <option key={n.id} value={n.id}>
                        {`${n.nozzle} — ${describeThrow(n.radius_ft)}`}
                      </option>
                    )
                  )}
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={coverageOn}
                onChange={(e) => setCoverageOn(e.target.checked)}
                aria-label="Show head coverage"
                className="h-3.5 w-3.5"
              />
              Show coverage
            </label>
            <p className="text-xs text-gray-500">
              Draw what you are installing and price it in minutes. Coverage shows
              what you placed, so gaps and overlaps are easy to spot — spacing,
              pressure and zoning stay your call.
            </p>
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
                {/* Coverage for THIS area, measured against every placed head.
                    The contract's describeCoverage lines render VERBATIM —
                    including the pressure caveat — and carry BOTH numbers the
                    report computes (reached %, overlap %). No single score is
                    invented here; that is a deliberate non-feature. */}
                {headsPlaced > 0 &&
                  (() => {
                    const rep = coverageReports.find((r) => r.areaId === area.id);
                    if (!rep) return null;
                    return (
                      <div className="w-full space-y-0.5 pl-9">
                        {describeCoverage(rep.report).map((line, i) => (
                          <p
                            key={i}
                            className={
                              i === 0 ? "text-xs text-gray-700" : "text-xs text-gray-500"
                            }
                          >
                            {line}
                          </p>
                        ))}
                      </div>
                    );
                  })()}
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

        {/* ---- Selected placed head: inspect / rotate / note / delete ---- */}
        {/* Mirrors the plant card. Rotation is only offered on part circles —
            a 360 ignores heading entirely. Deleting is the head's undo. */}
        {selectedHead && selectedHeadSnap && (
          <div className="space-y-2 rounded border border-gray-200/70 bg-white/50 p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">{selectedHead.name}</p>
                <p className="text-xs text-gray-500">
                  {selectedHeadSnap.nozzle || "nozzle?"} ·{" "}
                  {selectedHeadSnap.arc_deg === 360
                    ? "full circle"
                    : `${selectedHeadSnap.arc_deg}° arc`}{" "}
                  · {describeThrow(selectedHeadSnap.radius_ft)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHeadId("")}
                title="Close"
                aria-label="Close head card"
                className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {selectedAdjustment && (
              <p
                className={
                  selectedAdjustment.method === "below_minimum"
                    ? "text-xs font-medium text-red-700"
                    : "text-xs text-gray-500"
                }
              >
                {describeAdjustment(selectedAdjustment)}
              </p>
            )}
            {selectedHeadSnap.arc_deg !== 360 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Facing</span>
                <button
                  type="button"
                  onClick={() => void rotateHead(selectedHead, -45)}
                  aria-label="Rotate head 45 degrees left"
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                >
                  −45°
                </button>
                <button
                  type="button"
                  onClick={() => void rotateHead(selectedHead, 45)}
                  aria-label="Rotate head 45 degrees right"
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                >
                  +45°
                </button>
                <span className="text-xs tabular-nums text-gray-500">
                  {selectedHeadSnap.heading_deg}°
                </span>
              </div>
            )}
            <input
              type="text"
              value={plantNote[selectedHead.id] ?? selectedHeadSnap.note ?? ""}
              onChange={(e) => setPlantNote((n) => ({ ...n, [selectedHead.id]: e.target.value }))}
              onBlur={(e) => void savePlantNote(selectedHead, e.target.value)}
              placeholder="Note for this placement (optional)"
              aria-label="Placement note"
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void deleteArea(selectedHead)}
              className="w-full rounded border border-red-200 px-2 py-1 text-sm text-red-600"
            >
              Delete head
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
