import type { MetadataRoute } from "next";
import { BRAND, isLawn } from "@/lib/brand";

// PWA manifest, generated per-deploy from BRAND so the two variants install as
// distinct apps: construction = "Terra Vista" (blue, start at /dashboard), lawn
// = "Terra Verde" (green, start at /lawn). Served at /manifest.webmanifest
// (wired in layout.tsx metadata.manifest). Replaces the old static
// public/manifest.json. Icon PNGs are rasterized from the variant icon SVG by
// `npm run rasterize` (scripts/rasterize-icons.mjs) — run it after changing an
// icon SVG so the 192/512/apple PNGs match.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.tagline,
    start_url: isLawn() ? "/lawn" : "/dashboard",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: BRAND.themeColor,
    icons: [
      {
        src: BRAND.icon192Path,
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: BRAND.icon512Path,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: BRAND.iconPath,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}