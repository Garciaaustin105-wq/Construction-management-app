// Client-side location resolution with a fallback chain:
//   1. High-accuracy device GPS (navigator.geolocation)
//   2. If GPS is denied or unavailable → approximate IP geolocation via /api/geo
//      (Vercel's x-vercel-ip-latitude/longitude headers; coarse, ~city level)
//
// Returns the best result available plus a status the UI can render. There is
// NO web API for Bluetooth- or WiFi-based positioning — only native apps can do
// that — so IP geolocation is the only fallback a web page has when GPS is off.
//
// Import only from client components ("use client"); this touches navigator +
// fetch and must never run on the server.

export type GpsSource = "gps" | "ip";
export type GpsResult = {
  lat: number;
  lng: number;
  accuracy: number | null; // meters — GPS only; null for IP estimates
  source: GpsSource;
};
// "ok" = GPS resolved · "ip" = IP fallback resolved · "getting" = in progress
// "denied" = GPS blocked AND no IP fallback · "unavailable" = neither worked
export type GpsStatus = "idle" | "getting" | "ok" | "ip" | "denied" | "unavailable";

type Resolution = { result: GpsResult | null; status: GpsStatus };

export function resolveLocation(): Promise<Resolution> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    // No GPS API at all → go straight to the IP fallback.
    return ipFallback();
  }
  return new Promise<Resolution>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          result: {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? null,
            source: "gps",
          },
          status: "ok",
        }),
      async (err) => {
        // GPS denied or timed out — fall back to IP so we still capture something.
        const ip = await ipFallback();
        if (ip.result) resolve(ip);
        else
          resolve({
            result: null,
            status: err.code === err.PERMISSION_DENIED ? "denied" : "unavailable",
          });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });
}

async function ipFallback(): Promise<Resolution> {
  try {
    const res = await fetch("/api/geo", { cache: "no-store" });
    if (!res.ok) return { result: null, status: "unavailable" };
    const data = (await res.json()) as { lat?: number; lng?: number };
    if (typeof data.lat === "number" && typeof data.lng === "number") {
      return {
        result: { lat: data.lat, lng: data.lng, accuracy: null, source: "ip" },
        status: "ip",
      };
    }
    return { result: null, status: "unavailable" };
  } catch {
    return { result: null, status: "unavailable" };
  }
}