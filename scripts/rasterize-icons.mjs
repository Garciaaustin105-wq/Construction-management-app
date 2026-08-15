// Rasterize the home-screen SVG into the PNG sizes iOS/Android/Windows expect.
// iOS ignores SVG apple-touch icons, so it needs a real 180x180 PNG; Android
// PWA install wants 192 + 512 PNGs in the manifest. Run: node scripts/rasterize-icons.mjs
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public", "terra-vista-icon.svg"));

const sizes = [
  { name: "apple-icon.png", size: 180 }, // iOS apple-touch-icon
  { name: "icon-192.png", size: 192 }, // Android/PWA manifest
  { name: "icon-512.png", size: 512 }, // Android/PWA manifest (hi-res)
];

for (const { name, size } of sizes) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  writeFileSync(join(root, "public", name), png);
  console.log(`wrote public/${name} (${size}x${size}, ${png.length} bytes)`);
}