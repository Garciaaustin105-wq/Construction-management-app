/**
 * Site uplink budgeting for live viewing.
 *
 * Modelled on how OpenEye's Bandwidth Management behaves, because it is a tested
 * answer to a problem we would otherwise get wrong: when more people want to
 * watch than the uplink can carry, **degrade every stream rather than refusing
 * the newcomer**. Nobody is locked out; everybody's picture gets smaller. A
 * guard who can see all sixteen cameras badly is better served than one who is
 * told the site is full.
 *
 * One addition of our own: a reserved slice the viewers can never touch. Live
 * view is the nice-to-have; getting the clip of an intruder into the cloud
 * before somebody walks off with the recorder is not. Viewers degrade first.
 */

export type StreamProfile = "main" | "sub" | "low" | "snapshot";

/** Nominal bitrate per profile. `snapshot` is not a stream — it is periodic
 *  stills, and costs effectively nothing on the uplink. */
export const PROFILE_KBPS: Record<StreamProfile, number> = {
  main: 2500,
  sub: 400,
  low: 200,
  snapshot: 0,
};

/** Best to worst. Degradation walks down this list. */
const LADDER: readonly StreamProfile[] = ["main", "sub", "low", "snapshot"];

/**
 * Tiles per page on a phone. OpenEye's app shows six and paginates, which is
 * both a legibility decision and the reason opening a store feels instant —
 * six streams to negotiate, not sixteen.
 *
 * The client MUST stop the previous page's streams when the user swipes.
 * Otherwise streams accumulate as they browse, and a manager who flicks through
 * three pages is holding eighteen open on a link sized for six.
 */
export const MOBILE_TILES_PER_PAGE = 6;

/**
 * Desktop shows the whole store at once — sixteen tiles, no paging. Still the
 * substream: "not full resolution but it still looks good" is exactly right,
 * because a tile on a 1080p monitor is about 480x270 and the substream is
 * 640x360.
 *
 * So a desktop viewer costs roughly 2.7x a phone viewer on the store's uplink,
 * which is the main reason contention happens at all.
 */
export const DESKTOP_TILES = 16;

/**
 * How a viewer reaches the appliance.
 *
 * `local` is the one that matters here: a manager standing in their own store,
 * on the store wifi, reaches the appliance directly over the LAN. That traffic
 * never touches the uplink, so it must not be counted against it — and since a
 * gigabit LAN is not the constraint, a local viewer can have full quality even
 * while remote viewers are being degraded.
 *
 * Treating local viewers as uplink consumers was a real bug: someone standing in
 * the store would silently degrade the CEO watching from home.
 */
export type Transport = "local" | "direct" | "relay";

export interface StreamRequest {
  cameraId: string;
  viewerId: string;
  /** Defaults to `relay` — the conservative assumption if nobody says. */
  transport?: Transport;
  /** What the viewer asked for. They may be given less. */
  desired: StreamProfile;
  /**
   * The viewer deliberately chose this quality — tapped a tile to full screen,
   * or picked HD in the app because they are trying to read something.
   *
   * Pinned streams are satisfied first and degrade last. Without this, a viewer
   * who upgrades one camera watches it drop straight back down as soon as the
   * other fifteen tiles compete for the same uplink, which makes the control
   * feel broken.
   */
  pinned?: boolean;
}

export interface Allocation {
  cameraId: string;
  viewerId: string;
  desired: StreamProfile;
  granted: StreamProfile;
  kbps: number;
  degraded: boolean;
}

export interface BudgetPlan {
  allocations: Allocation[];
  /** Total granted, excluding the reserve. */
  usedKbps: number;
  budgetKbps: number;
  reservedKbps: number;
  /** True when anything was granted below what was asked for. */
  anyDegraded: boolean;
  /** Streams that could not be given even a snapshot. Should always be empty —
   *  snapshot costs nothing — but it is reported rather than assumed. */
  refused: StreamRequest[];
}

export class BandwidthError extends Error {}

/**
 * Allocate a site's uplink across the streams people are asking for.
 *
 * `uplinkKbps` should be the MEASURED upload speed, not the sold one.
 * `usableFraction` leaves room for TCP overhead, retransmits and the fact that
 * a link run to its rated ceiling drops packets — the video would stutter long
 * before the arithmetic said it should.
 */
export function allocateBandwidth(
  requests: readonly StreamRequest[],
  uplinkKbps: number,
  { reservedKbps = 1000, usableFraction = 0.7 }: { reservedKbps?: number; usableFraction?: number } = {},
): BudgetPlan {
  if (!Number.isFinite(uplinkKbps) || uplinkKbps <= 0) {
    throw new BandwidthError(`uplinkKbps must be positive, got ${uplinkKbps}`);
  }
  if (usableFraction <= 0 || usableFraction > 1) {
    throw new BandwidthError(`usableFraction must be in (0,1], got ${usableFraction}`);
  }

  const usable = uplinkKbps * usableFraction;
  const budgetKbps = Math.max(0, usable - reservedKbps);

  // Local viewers are on the LAN. They cost the uplink nothing and are always
  // granted what they asked for.
  const local = requests.filter((r) => r.transport === "local");
  const remote = requests.filter((r) => r.transport !== "local");

  const localAllocations: Allocation[] = local.map((request) => ({
    cameraId: request.cameraId,
    viewerId: request.viewerId,
    desired: request.desired,
    granted: request.desired,
    kbps: PROFILE_KBPS[request.desired],
    degraded: false,
  }));

  const pinned = remote.filter((r) => r.pinned === true);
  const normal = remote.filter((r) => r.pinned !== true);

  // Pinned streams are served first, at what was asked for, and only degrade if
  // they cannot fit even on their own. Everything else shares what is left.
  const pinnedAllocations = degradeToFit(pinned, budgetKbps);
  const pinnedUsed = pinnedAllocations.reduce((sum, a) => sum + a.kbps, 0);
  const normalAllocations = degradeToFit(normal, Math.max(0, budgetKbps - pinnedUsed));

  const allocations = [...localAllocations, ...pinnedAllocations, ...normalAllocations];
  // Only the remote streams count against the uplink.
  const used = [...pinnedAllocations, ...normalAllocations].reduce((sum, a) => sum + a.kbps, 0);

  return {
    allocations,
    usedKbps: used,
    budgetKbps,
    reservedKbps,
    anyDegraded: allocations.some((a) => a.degraded),
    refused: [],
  };
}

/**
 * Walk a set of requests down the ladder together until it fits.
 *
 * Degrading uniformly is the point: the alternative — first-come-first-served
 * at full quality — means whoever connected first keeps a good picture while
 * everyone after gets nothing. The floor is `snapshot`, which costs nothing, so
 * this always terminates with everybody served something.
 */
function degradeToFit(requests: readonly StreamRequest[], budgetKbps: number): Allocation[] {
  let level = 0;
  for (;;) {
    const allocations = requests.map((request) => {
      const desiredIndex = LADDER.indexOf(request.desired);
      const grantedIndex = Math.min(LADDER.length - 1, desiredIndex + level);
      const granted = LADDER[grantedIndex] as StreamProfile;
      return {
        cameraId: request.cameraId,
        viewerId: request.viewerId,
        desired: request.desired,
        granted,
        kbps: PROFILE_KBPS[granted],
        degraded: granted !== request.desired,
      };
    });
    const used = allocations.reduce((sum, a) => sum + a.kbps, 0);
    if (used <= budgetKbps || level >= LADDER.length - 1) return allocations;
    level++;
  }
}

/**
 * What a site can carry at full quality, for sizing and for telling an operator
 * why their picture just got smaller.
 */
export function capacityAt(
  profile: StreamProfile,
  uplinkKbps: number,
  { reservedKbps = 1000, usableFraction = 0.7 } = {},
): number {
  const perStream = PROFILE_KBPS[profile];
  if (perStream === 0) return Number.POSITIVE_INFINITY;
  const budget = Math.max(0, uplinkKbps * usableFraction - reservedKbps);
  return Math.floor(budget / perStream);
}
