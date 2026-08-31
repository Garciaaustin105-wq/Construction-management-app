// Shared contract for live crew tracking (lawn). Imported by BOTH the crew
// broadcaster (useCrewLocationBroadcast) and the office map (/lawn/track), so
// the channel name, event names and payload shape can never drift apart —
// a mismatch here fails silently (the office map just stays empty), which is
// exactly the kind of bug that is expensive to notice.
//
// ── Why Realtime Broadcast, not an API route ──────────────────────────────
// The live layer is Supabase Realtime BROADCAST: the crew client publishes
// straight to Supabase and the office map subscribes. It never touches Vercel
// and writes no rows. The obvious alternative — POST to /api/... every 30s —
// would be ~211k Vercel invocations and 211k DB rows per month for 10 crew,
// which is the same shape of load that caused the 10-second page loads this
// codebase just finished removing.
//
// Persistence is separate and deliberately sparse: a `crew_locations`
// breadcrumb roughly every BREADCRUMB_MS, written by the crew client directly
// under RLS (also zero Vercel invocations). See the crew_location_breadcrumbs
// migration.
//
// ── Why presence-gated ────────────────────────────────────────────────────
// Crew clients join the channel but stay SILENT until Presence reports at least
// one office viewer watching. Nobody looking, nothing transmitted. That is the
// single biggest cost lever (typically ~80% less traffic than always-on) and it
// implements "live location when needed" literally rather than approximately.

/** Realtime channel for one org's crew tracking. Org-scoped so a subscriber
 *  can only ever hear its own tenant's traffic. */
export function crewChannelName(orgId: string): string {
  return `org:${orgId}:crew`;
}

/** Broadcast event: a crew member's current position. */
export const EVENT_POSITION = "crew_position";
/** Broadcast event: a crew member went off-shift / stopped sharing, so the
 *  office map can drop the pin immediately instead of waiting for it to age
 *  out. Best-effort — a phone that loses signal never sends it, which is why
 *  STALE_MS exists too. */
export const EVENT_OFFLINE = "crew_offline";

/** Presence key the OFFICE map registers under. Crew clients count presences
 *  carrying this role to decide whether anyone is watching. */
export const PRESENCE_ROLE_VIEWER = "viewer";
/** Presence key crew register under, so the office can distinguish "on shift
 *  but hasn't sent a fix yet" from "not on shift at all". */
export const PRESENCE_ROLE_CREW = "crew";

/** How often the crew client broadcasts while someone is watching. 30s is the
 *  balance point: fast enough that a truck visibly moves between updates, slow
 *  enough to stay far inside the Realtime message quota and not cook a phone
 *  battery over an 8-hour shift. */
export const BROADCAST_MS = 30_000;

/** How often a position is PERSISTED as a breadcrumb. Deliberately ~10x the
 *  broadcast interval: answering "was he at the property at 2pm" does not need
 *  30-second granularity, and keeping it coarse is both cheaper and a smaller
 *  privacy footprint. */
export const BREADCRUMB_MS = 300_000; // 5 minutes

/** A pin older than this is treated as stale and dropped from the map. Covers
 *  the case a phone dies, loses signal, or force-quits without sending
 *  EVENT_OFFLINE. Generous relative to BROADCAST_MS so one missed tick does not
 *  flicker a crew member off the map. */
export const STALE_MS = 150_000; // 2.5 minutes ≈ 5 missed broadcasts

/** Retention of the breadcrumb trail, mirrored by purge_crew_locations(). Kept
 *  short on purpose: employee location tracking is regulated and varies by
 *  state, so this is a working record for dispute resolution, not a long-term
 *  surveillance archive. */
export const RETENTION_DAYS = 7;

/** One crew member's position as broadcast on the channel. */
export type CrewPosition = {
  userId: string;
  name: string | null;
  lat: number;
  lng: number;
  /** GPS accuracy radius in metres, when the device reports it. */
  accuracyM: number | null;
  /** Degrees clockwise from true north, when moving. null when stationary. */
  headingDeg: number | null;
  /** Metres per second, when the device reports it. */
  speedMps: number | null;
  /** Epoch ms when the fix was taken on the device (not when received). */
  at: number;
};

/** True when a fix is too old to still be shown as "live". */
export function isStale(pos: Pick<CrewPosition, "at">, now = Date.now()): boolean {
  return now - pos.at > STALE_MS;
}

/** m/s → mph, for the office UI. Returns null when speed is unavailable, which
 *  is common when a device is stationary or indoors. */
export function mphFromMps(speedMps: number | null): number | null {
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0) return null;
  return Math.round(speedMps * 2.236936);
}

/** "2 min ago" / "just now" for pin labels. Kept here rather than in the page
 *  so the crew-side indicator can show the same wording. */
export function agoLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
