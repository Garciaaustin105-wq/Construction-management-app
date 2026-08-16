// Rasterize each variant's icon SVG into the PNG sizes iOS/Android/Windows
// expect. iOS ignores SVG apple-touch icons, so it needs a real 180x180 PNG;
// Android/PWA install wants 192 + 512 PNGs in the manifest. The repo ships two
// variants off one codebase: construction (terra-vista-*) and lawn (terra-verde-*).
// Run after changing either icon SVG:  node scripts/rasterize-icons.mjs
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// prefix is prepended to each output filename so construction keeps its existing
// bare names (apple-icon.png / icon-192.png / icon-512.png) while lawn gets
// terra-verde-apple-icon.png / terra-verde-icon-192.png / terra-verde-icon-512.png
// — matching the paths in src/lib/brand.ts.
const variants = [
  { svg: "terra-vista-icon.svg", prefix: "" },
  { svg: "terra-verde-icon.svg", prefix: "terra-verde-" },
];

const sizes = [
  { name: "apple-icon.png", size: 180 }, // iOS apple-touch-icon
  { name: "icon-192.png", size: 192 }, // Android/PWA manifest
  { name: "icon-512.png", size: 512 }, // Android/PWA manifest (hi-res)
];

for (const { svg, prefix } of variants) {
  const svgPath = join(root, "public", svg);
  if (!existsSync(svgPath)) {
    console.log(`skip ${svg} (not found)`);
    continue;
  }
  const svgBuf = readFileSync(svgPath);
  for (const { name, size } of sizes) {
    const resvg = new Resvg(svgBuf, { fitTo: { mode: "width", value: size } });
    const png = resvg.render().asPng();
    const out = prefix + name;
    writeFileSync(join(root, "public", out), png);
    console.log(`wrote public/${out} (${size}x${size}, ${png.length} bytes)`);
  }
}