// Server-side Google Static Maps URL builder for the customer visit emails.
//
// The map image is fetched by the RECIPIENT'S email client (Gmail, Apple Mail,
// …), which sends no HTTP-Referer header — so the URL CANNOT use the
// HTTP-referrer-restricted public key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY); that
// would 403 in every inbox. Instead it uses a SEPARATE server key,
// GOOGLE_MAPS_STATIC_KEY, that is API-restricted to the Static Maps API only
// and has NO application (referrer) restriction. The key value is necessarily
// visible in the email's <img src> HTML; API-restriction limits the blast
// radius to "someone could generate map images on your quota," which is
// acceptable and is the standard pattern for Static Maps in email.
//
// Returns null when GOOGLE_MAPS_STATIC_KEY is unset OR the lat/lng is missing —
// the caller then omits the <img> entirely so the email still sends, just
// without a map (no hard dependency on the key being configured).

const STATIC_BASE = "https://maps.googleapis.com/maps/api/staticmap";

/**
 * Build a 300×160 (@2x → 600×320 px) Static Maps image URL centered on the
 * property pin, or null when the key/pin is unavailable.
 */
export function buildStaticMapUrl(
  lat: number | null | undefined,
  lng: number | null | undefined
): string | null {
  const key = process.env.GOOGLE_MAPS_STATIC_KEY?.trim();
  if (!key) return null;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }
  const latStr = String(Math.round(lat * 1e6) / 1e6);
  const lngStr = String(Math.round(lng * 1e6) / 1e6);
  // size=300x160 + scale=2 → crisp on retina. zoom=15 ≈ a few city blocks, good
  // for a single-property context. Green marker matches the in-app lawn pins.
  const params = new URLSearchParams({
    size: "300x160",
    scale: "2",
    zoom: "15",
    center: `${latStr},${lngStr}`,
    markers: `color:0x16a34a|${latStr},${lngStr}`,
    key,
  });
  return `${STATIC_BASE}?${params.toString()}`;
}