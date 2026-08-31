// Grouping the day's stops into work AREAS rather than individual properties.
//
// Suburban lots sit 25-30 m apart and GPS error is 10-20 m, so asking "which
// house is the mower on" is false precision — inventing resolution the sensor
// does not have. And while a crew works a street the question is not even
// meaningful: the mower, the edger and the blower are on three different lawns
// at the same time.
//
// So the geofence fences the CLUSTER. Leaving a cluster means driving hundreds
// of metres, which GPS resolves easily, and per-house attribution is replaced
// by something honest: "the crew was on this street for 95 minutes and all four
// properties were serviced."
//
// Distance comes from geofence.ts rather than a second copy. Two haversine
// implementations that can drift apart is precisely the failure this codebase
// already warns about elsewhere — it would show up as a cluster boundary that
// disagrees with the geofence radius by a few metres, intermittently.

import { distanceMeters } from "@/lib/geofence";

export type ClusterStop = {
  id: string;
  lat: number;
  lng: number;
};

export type Cluster = {
  /** Stable id, assigned after the final sort: "c0", "c1", … */
  id: string;
  /** Member stop ids, ascending. */
  stopIds: string[];
  /** Arithmetic mean of member positions. */
  centroid: { lat: number; lng: number };
  /** Greatest distance from centroid to any member. 0 for a single stop. */
  radiusM: number;
};

export type ClusterOptions = {
  /** Two stops link when within this many metres of each other. */
  linkRadiusM?: number;
};

export const CLUSTER_DEFAULTS: Required<ClusterOptions> = {
  // Comfortably wider than a suburban lot (25-30 m) and than the geofence's own
  // 150 m exit radius, so stops the geofence cannot separate always land in one
  // cluster. Narrow enough that the next street over stays a separate bubble.
  linkRadiusM: 250,
};

/**
 * Single-link (transitive) clustering.
 *
 * Transitive is the whole point, and it is why this is not distance-to-centroid
 * or k-means. A row of twelve houses down one street is one continuous work
 * area even though the first and last are half a kilometre apart — no fixed
 * radius around a centroid describes that shape, but "each house is within
 * 250 m of the next" describes it exactly. Chaining is normally the weakness of
 * single-link clustering; here it is the feature, because streets chain.
 *
 * Deterministic: stops are processed in id order and the output is sorted, so
 * the same day always produces the same clusters regardless of the order the
 * caller happened to fetch its visits in. That matters because cluster ids end
 * up in geofence state that persists across a shift.
 */
export function clusterStops(
  stops: ClusterStop[],
  options?: ClusterOptions
): Cluster[] {
  const { linkRadiusM } = { ...CLUSTER_DEFAULTS, ...options };
  if (stops.length === 0) return [];

  // Sorted copy — never reorder the caller's array.
  const ordered = [...stops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(ordered.map((s) => [s.id, s]));

  const links = new Map<string, string[]>(ordered.map((s) => [s.id, []]));
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i];
      const b = ordered[j];
      if (distanceMeters(a.lat, a.lng, b.lat, b.lng) <= linkRadiusM) {
        links.get(a.id)!.push(b.id);
        links.get(b.id)!.push(a.id);
      }
    }
  }

  // Iterative flood fill rather than recursion: cluster size is unbounded in
  // principle (one long route through a dense subdivision chains a long way),
  // and a stack overflow inside the GPS handler would kill tracking for the
  // rest of the shift.
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const start of ordered) {
    if (seen.has(start.id)) continue;
    const group: string[] = [];
    const queue = [start.id];
    seen.add(start.id);
    while (queue.length > 0) {
      const id = queue.pop()!;
      group.push(id);
      for (const next of links.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    group.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    groups.push(group);
  }

  groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return groups.map((stopIds, index) => {
    let latSum = 0;
    let lngSum = 0;
    for (const id of stopIds) {
      const s = byId.get(id)!;
      latSum += s.lat;
      lngSum += s.lng;
    }
    const centroid = { lat: latSum / stopIds.length, lng: lngSum / stopIds.length };
    let radiusM = 0;
    for (const id of stopIds) {
      const s = byId.get(id)!;
      const d = distanceMeters(centroid.lat, centroid.lng, s.lat, s.lng);
      if (d > radiusM) radiusM = d;
    }
    return { id: `c${index}`, stopIds, centroid, radiusM };
  });
}

/** Which work area a given visit belongs to, or null if it is not in the day. */
export function clusterOf(stopId: string, clusters: Cluster[]): Cluster | null {
  for (const cluster of clusters) {
    if (cluster.stopIds.includes(stopId)) return cluster;
  }
  return null;
}

/** Nearest work area by centroid. Ties resolve to the earlier cluster. */
export function nearestCluster(
  lat: number,
  lng: number,
  clusters: Cluster[]
): { cluster: Cluster; distanceM: number } | null {
  if (clusters.length === 0) return null;
  let best = {
    cluster: clusters[0],
    distanceM: distanceMeters(lat, lng, clusters[0].centroid.lat, clusters[0].centroid.lng),
  };
  for (let i = 1; i < clusters.length; i++) {
    const c = clusters[i];
    const d = distanceMeters(lat, lng, c.centroid.lat, c.centroid.lng);
    if (d < best.distanceM) best = { cluster: c, distanceM: d };
  }
  return best;
}
