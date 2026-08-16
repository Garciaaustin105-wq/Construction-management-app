// Route optimization + zone grouping for the daily lawn route planner.
// All pure functions — the planner page feeds in the day's visits (with map
// pins) and crew list, and these produce zone clusters + per-zone optimized
// stop orders. No network, no randomness (deterministic so the same day always
// clusters the same way — stable UX + cache-friendly).
//
// Geometry is straight-line haversine (no road network / paid map API). Drive
// time is a rough estimate from straight-line miles (×1.3 road factor, ÷35 mph)
// — clearly labelled "est." in the UI; it is for dispatcher planning, not ETA.

export type LatLng = { lat: number; lng: number };

export type RouteStop = {
  id: string;
  jobId: string;
  jobName: string;
  address: string | null;
  customerName: string | null;
  serviceType: string | null;
  crewId: string | null;
  status: string;
  dueDate: string;
  pos: LatLng | null; // null = no map pin (unmapped)
  // Previously-saved per-crew sequence for the day (lawn_visits.route_order).
  // The map planner seeds its list order from this (falls back to nearest-neighbor),
  // so a saved plan isn't lost on reload.
  routeOrder: number | null;
};

export type CrewInfo = { id: string; name: string };

export type Zone = {
  id: number;
  label: string;
  crewId: string | null; // dispatcher-assigned crew for the whole zone (optional)
  centroid: LatLng;
  stops: RouteStop[]; // UNORDERED — call nearestNeighborRoute to order
  miles: number; // sum of inter-stop straight-line miles once ordered
};

const EARTH_R_MI = 3958.7613;

/** Straight-line distance between two points, in miles. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_MI * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Greedy nearest-neighbor ordering of the mapped stops, starting from the stop
 * nearest the zone centroid. Unmapped stops (no pin) are appended after the
 * mapped run in their original order — they can't be sequenced by distance.
 */
export function nearestNeighborRoute(stops: RouteStop[]): RouteStop[] {
  const mapped = stops.filter((s) => s.pos);
  const unmapped = stops.filter((s) => !s.pos);
  if (mapped.length <= 1) return [...mapped, ...unmapped];

  // Start point = centroid of mapped stops (so the route begins centrally
  // rather than at an arbitrary corner).
  const centroid: LatLng = {
    lat: mapped.reduce((s, p) => s + (p.pos!.lat), 0) / mapped.length,
    lng: mapped.reduce((s, p) => s + (p.pos!.lng), 0) / mapped.length,
  };

  // Seed = mapped stop closest to centroid.
  let seedIdx = 0;
  let seedDist = Infinity;
  for (let i = 0; i < mapped.length; i++) {
    const d = haversineMiles(centroid, mapped[i].pos!);
    if (d < seedDist) {
      seedDist = d;
      seedIdx = i;
    }
  }

  const ordered: RouteStop[] = [mapped[seedIdx]];
  const remaining = mapped.filter((_, i) => i !== seedIdx);
  let cursor = ordered[0].pos!;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMiles(cursor, remaining[i].pos!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    cursor = next.pos!;
  }
  return [...ordered, ...unmapped];
}

/** Total straight-line miles along an ordered stop list (sum of legs). */
export function routeMiles(ordered: RouteStop[]): number {
  let total = 0;
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1].pos;
    const b = ordered[i].pos;
    if (a && b) total += haversineMiles(a, b);
  }
  return total;
}

/**
 * Rough drive-time estimate (minutes) from straight-line miles: ×1.3 road
 * factor, ÷35 mph. Purely advisory for dispatcher planning.
 */
export function estDriveMinutes(miles: number): number {
  return (miles * 1.3) / 35 * 60;
}

/**
 * Deterministic k-means clustering of mapped stops into `k` geographic zones.
 * Unmapped stops are returned as a single trailing "Unmapped" zone.
 *
 * Determinism: seeds are picked by sorting mapped stops by (lat, lng) and taking
 * `k` evenly-spaced indices — no Math.random, so re-running on the same inputs
 * always yields the same zones. `k` is clamped to [1, mappedCount].
 *
 * Returns zones in order [zone 1 .. zone k, Unmapped (if any)], each with its
 * centroid + (unordered) stops. The caller orders each zone via
 * nearestNeighborRoute().
 */
export function clusterZones(stops: RouteStop[], k: number): Zone[] {
  const mapped = stops.filter((s) => s.pos);
  const unmapped = stops.filter((s) => !s.pos);

  if (mapped.length === 0) {
    return unmapped.length
      ? [
          {
            id: 0,
            label: "Unmapped",
            crewId: null,
            centroid: { lat: 0, lng: 0 },
            stops: unmapped,
            miles: 0,
          },
        ]
      : [];
  }

  const kk = Math.max(1, Math.min(k, mapped.length));

  // Deterministic seed selection: sort by lat then lng, take k evenly-spaced.
  const sorted = [...mapped].sort((a, b) =>
    a.pos!.lat !== b.pos!.lat
      ? a.pos!.lat - b.pos!.lat
      : a.pos!.lng - b.pos!.lng
  );
  let seeds: LatLng[] = [];
  if (kk === 1) {
    seeds.push(sorted[0].pos!);
  } else {
    for (let i = 0; i < kk; i++) {
      const idx = Math.floor((i * (sorted.length - 1)) / (kk - 1));
      seeds.push(sorted[idx].pos!);
    }
  }

  const assignments = new Array(mapped.length).fill(0);
  // A few refinement rounds (cap 8) — recompute centroids, reassign.
  for (let round = 0; round < 8; round++) {
    // Recompute centroids from current assignments.
    const sums: LatLng[] = seeds.map(() => ({ lat: 0, lng: 0 }));
    const counts = new Array(kk).fill(0);
    for (let i = 0; i < mapped.length; i++) {
      const c = assignments[i];
      sums[c].lat += mapped[i].pos!.lat;
      sums[c].lng += mapped[i].pos!.lng;
      counts[c] += 1;
    }
    const centroids: LatLng[] = sums.map((s, c) =>
      counts[c] > 0
        ? { lat: s.lat / counts[c], lng: s.lng / counts[c] }
        : seeds[c]
    );

    // Reassign each stop to its nearest centroid.
    let changed = false;
    for (let i = 0; i < mapped.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = haversineMiles(centroids[c], mapped[i].pos!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best !== assignments[i]) {
        assignments[i] = best;
        changed = true;
      }
    }
    seeds = centroids;
    if (!changed) break;
  }

  const zones: Zone[] = [];
  let zoneNo = 0;
  for (let c = 0; c < kk; c++) {
    const zStops = mapped.filter((_, i) => assignments[i] === c);
    if (zStops.length === 0) continue; // empty cluster — skip
    zoneNo += 1;
    const lat = zStops.reduce((s, p) => s + p.pos!.lat, 0) / zStops.length;
    const lng = zStops.reduce((s, p) => s + p.pos!.lng, 0) / zStops.length;
    zones.push({
      id: zoneNo,
      label: `Zone ${zoneNo}`,
      crewId: null,
      centroid: { lat, lng },
      stops: zStops,
      miles: 0,
    });
  }

  if (unmapped.length > 0) {
    zones.push({
      id: 0,
      label: "Unmapped",
      crewId: null,
      centroid: { lat: 0, lng: 0 },
      stops: unmapped,
      miles: 0,
    });
  }

  return zones;
}

/** Crew display name from a profiles row (first name preferred). */
export function crewDisplayName(
  crew: { id: string; full_name?: string | null; email?: string | null } | null
): string {
  if (!crew) return "Unassigned";
  return crew.full_name || crew.email || "Crew";
}