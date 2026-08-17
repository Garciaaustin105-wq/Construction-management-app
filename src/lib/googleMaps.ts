// Client-side Google Maps JS API bootstrap. Used by the lawn route maps
// (office RouteMapPlanner + crew My Route) after the Leaflet/OSM swap.
//
// The API key is NEXT_PUBLIC_ so it is baked into the client bundle at build
// time — the same exposure the Maps JS <script src> would have anyway. Restrict
// it in Google Cloud Console via HTTP-referrer limits (the two app domains),
// not by trying to hide a client-exposed value. Enable Maps JavaScript API,
// Geocoding API, Directions API, Places API, and Distance Matrix API on the key
// (Geocoding + Directions + Places Autocomplete + Distance Matrix all run
// client-side under this same public key now — see RouteMapPlanner/
// GoogleRouteMap/AddressInput).
//
// `@googlemaps/js-api-loader` `Loader` is a singleton by contract: constructing
// a second Loader throws, and `load()` is idempotent (repeated calls resolve to
// the same promise). So we memoize ONE Loader + ONE in-flight load at module
// scope and just hand out the resolved `google` global.

import { Loader } from "@googlemaps/js-api-loader";

export const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

let _loadPromise: Promise<typeof google> | null = null;

/** Load the Google Maps JS API once; subsequent calls share the same promise. */
export function loadGoogleMaps(): Promise<typeof google> {
  if (_loadPromise) return _loadPromise;
  if (!GOOGLE_MAPS_API_KEY) {
    _loadPromise = Promise.reject(
      new Error(
        "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set. Add it to Vercel env (both projects) + redeploy, and enable Maps JS + Geocoding + Directions + Places + Distance Matrix APIs on the key."
      )
    );
    return _loadPromise;
  }
  const loader = new Loader({
    apiKey: GOOGLE_MAPS_API_KEY,
    version: "weekly",
    // `places` is required by AddressInput (Autocomplete). Geocoder,
    // DirectionsService, and DistanceMatrixService are all in core (no library
    // needed). Loading `places` here means a single script load covers every
    // map + autocomplete instance in the app.
    libraries: ["places"],
  });
  // loader.load() resolves once the `google` global is available.
  _loadPromise = loader.load().then(() => google);
  return _loadPromise;
}