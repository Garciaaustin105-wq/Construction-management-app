"use client";

import { useEffect } from "react";
import { captureAttributionFromUrl } from "@/lib/attribution";

// Mounted once in the root layout (renders nothing). Runs on every page load
// so a visitor landing anywhere with a utm_* querystring (a Google Ads click,
// a tagged blog link) gets that attribution stamped for this session before
// they navigate on to /signup. See src/lib/attribution.ts.
export default function AttributionCapture() {
  useEffect(() => {
    captureAttributionFromUrl();
  }, []);
  return null;
}
