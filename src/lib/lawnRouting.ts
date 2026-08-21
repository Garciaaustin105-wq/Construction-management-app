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
  return [...refineRouteHaversine(ordered), ...unmapped];
}

/**
 * 2-opt local-search refinement: repeatedly considers reversing a segment
 * [i+1..j] of the list and keeps the reversal if it strictly reduces the sum
 * of the two edges touching the segment's endpoints — the standard O(1)-per-
 * candidate 2-opt delta check (no full-path recompute), so a full pass is
 * O(n²). Removes the edge crossings a pure greedy nearest-neighbor walk tends
 * to leave behind. Repeats passes until one finds no improving swap, capped
 * at 20 passes so a large day can't spin. Deterministic (no randomness) —
 * the same input order always refines to the same output.
 */
export function twoOpt<T>(order: T[], cost: (a: T, b: T) => number): T[] {
  const n = order.length;
  if (n < 4) return order; // nothing to usefully reverse below a 4-stop chain
  let arr = [...order];
  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false;
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const before = cost(arr[i], arr[i + 1]) + cost(arr[j], arr[j + 1]);
        const after = cost(arr[i], arr[j]) + cost(arr[i + 1], arr[j + 1]);
        if (after < before - 1e-9) {
          const reversed = arr.slice(i + 1, j + 1).reverse();
          arr = [...arr.slice(0, i + 1), ...reversed, ...arr.slice(j + 1)];
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return arr;
}

/** twoOpt keyed on straight-line haversine distance between mapped stops. */
export function refineRouteHaversine(order: RouteStop[]): RouteStop[] {
  return twoOpt(order, (a, b) => haversineMiles(a.pos!, b.pos!));
}

/**
 * twoOpt keyed on a real drive-duration matrix (seconds), same shape as
 * nearestNeighborByMatrix's `durationSec`. `mappedStops` is the array whose
 * index order the matrix's rows/columns correspond to (built once by the
 * caller alongside the matrix) — NOT `order`, which is already reordered.
 * The id→index map is built once from `mappedStops` up front.
 */
export function refineRouteMatrix(
  order: RouteStop[],
  mappedStops: RouteStop[],
  durationSec: number[][]
): RouteStop[] {
  const idToIdx = new Map(mappedStops.map((s, i) => [s.id, i]));
  return twoOpt(order, (a, b) => {
    const ai = idToIdx.get(a.id);
    const bi = idToIdx.get(b.id);
    if (ai === undefined || bi === undefined) return Infinity;
    return durationSec[ai]?.[bi] ?? Infinity;
  });
}

/**
 * Greedy nearest-neighbor ordering of MAPPED stops keyed on a real drive-
 * duration matrix (seconds) from the Distance Matrix API, instead of straight-
 * line haversine. `durationSec[i][j]` is the drive duration from mappedStops[i]
 * to mappedStops[j]. The seed is the stop closest (haversine) to the centroid —
 * the same starting heuristic as nearestNeighborRoute — then each step picks
 * the not-yet-visited stop with the shortest DRIVE time from the current one.
 *
 * If a matrix cell is missing/invalid (Distance Matrix returns null for
 * unreachable pairs), that leg falls back to haversine so the walk never stalls.
 *
 * Returns only the mapped stops in optimized order; the CALLER appends unmapped
 * stops (which have no matrix row) after this, exactly as nearestNeighborRoute
 * appends them. If the matrix is undersized for the stop list, bail safe and
 * return the input order unchanged.
 */
export function nearestNeighborByMatrix(
  mappedStops: RouteStop[],
  durationSec: number[][]
): RouteStop[] {
  const n = mappedStops.length;
  if (n <= 1) return [...mappedStops];
  if (durationSec.length < n) return [...mappedStops];

  const centroid: LatLng = {
    lat: mappedStops.reduce((s, p) => s + (p.pos!.lat), 0) / n,
    lng: mappedStops.reduce((s, p) => s + (p.pos!.lng), 0) / n,
  };
  let seedIdx = 0;
  let seedDist = Infinity;
  for (let i = 0; i < n; i++) {
    const d = haversineMiles(centroid, mappedStops[i].pos!);
    if (d < seedDist) {
      seedDist = d;
      seedIdx = i;
    }
  }

  const visited = new Set<number>([seedIdx]);
  const ordered: RouteStop[] = [mappedStops[seedIdx]];
  let cursor = seedIdx;
  while (ordered.length < n) {
    let bestIdx = -1;
    let bestDur = Infinity;
    const row = durationSec[cursor] ?? [];
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      const d = row[j];
      if (typeof d === "number" && d >= 0 && d < bestDur) {
        bestDur = d;
        bestIdx = j;
      }
    }
    if (bestIdx === -1) {
      // No usable drive duration from the cursor — fall back to haversine among
      // the remaining stops so we never get stuck mid-walk.
      for (let j = 0; j < n; j++) {
        if (visited.has(j)) continue;
        const d = haversineMiles(mappedStops[cursor].pos!, mappedStops[j].pos!);
        if (d < bestDur) {
          bestDur = d;
          bestIdx = j;
        }
      }
    }
    visited.add(bestIdx);
    ordered.push(mappedStops[bestIdx]);
    cursor = bestIdx;
  }
  return refineRouteMatrix(ordered, mappedStops, durationSec);
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

/** Crew display name from a crew_members row (linked app user or scheduling-only). */
export function crewDisplayName(
  crew: { id: string; name?: string | null } | null
): string {
  if (!crew) return "Unassigned";
  return crew.name || "Crew";
}