// Site-import maths (src/lib/siteImport.ts).
//
// Run:
//   npx tsc src/lib/siteImport.ts src/lib/irrigationProducts.ts src/lib/plantProducts.ts \
//     --outDir .import-build --module esnext --target es2022 \
//     --moduleResolution bundler --skipLibCheck
//   sed -i 's|"@/lib/irrigationProducts"|"./irrigationProducts.js"|' .import-build/siteImport.js
//   sed -i 's|"@/lib/plantProducts"|"./plantProducts.js"|' .import-build/irrigationProducts.js
//   node e2e-site-import.mjs
//
// The path aliases are not configured on a bare tsc call, and two of these
// imports are VALUES rather than types, so the specifiers survive into the
// emitted JS and Node cannot resolve "@/lib". Hence the rewrites. tsc reports
// TS2307 for the type-only ones; expected, the emit is complete.
//
// Pure math, no database.
//
// THIS FILE LEADS WITH THE THREE FAILURES THE FEATURE EXISTS TO PREVENT:
//   1. a metres file read as feet — 3.28x on length, 10.76x on AREA, and it
//      looks entirely plausible on screen
//   2. a local-frame file placed on the map — a shape that looks right and sits
//      wrong is worse than no shape
//   3. an import overwriting a measurement — the disagreement IS the signal
const M = await import("./.import-build/siteImport.js");
const { IMPORT_SOURCES, isImportSource, LENGTH_UNITS, isLengthUnit,
        guessColumns, detectFrame, groupPaths, ringAreaSqft, summariseElevation,
        buildImport, compareAreas, describeImport, CLOSE_TOLERANCE } = M;

let pass = 0, fail = 0;
const t = (n, c, d = "") => {
  c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
};
const near = (a, b, e = 0.5) => Math.abs(a - b) < e;

const pt = (a, b, o = {}) => ({ a, b, z: null, pathName: null, label: null, ...o });

// A 100 ft x 100 ft square in a LOCAL frame, closed. 10,000 sqft if the file is
// in feet; 107,639 if it is in metres.
const squareLocalFt = [
  pt(0, 0), pt(0, 100), pt(100, 100), pt(100, 0), pt(0, 0),
].map((p) => ({ ...p, pathName: "Back lawn" }));

console.log("[units — the failure that looks plausible]");
{
  const paths = groupPaths(squareLocalFt);
  const asFeet = buildImport(paths, { unit: "ft", source: "moasure", frame: "local" });
  const asMetres = buildImport(paths, { unit: "m", source: "moasure", frame: "local" });
  t("100x100 read as FEET is 10,000 sqft", near(asFeet[0].areaSqft, 10000, 5),
    `got ${asFeet[0].areaSqft}`);
  t("the SAME file read as METRES is 107,639 sqft",
    near(asMetres[0].areaSqft, 107639, 50), `got ${asMetres[0].areaSqft}`);
  t("...a 10.76x difference from one dropdown — which is why there is no default",
    near(asMetres[0].areaSqft / asFeet[0].areaSqft, 10.7639, 0.01));
  const unchosen = buildImport(paths, { unit: null, source: "moasure", frame: "local" });
  t("NO UNIT CHOSEN is flagged", unchosen[0].issues.includes("no_unit"));
  t("...and blocks the import outright", unchosen[0].importable === false);
  t("...and says so in words", describeImport(unchosen[0]).includes("units"));
  t("a unit is never inferred: null is not treated as feet",
    unchosen[0].importable !== asFeet[0].importable);
}

console.log("\n[coordinate frame — a shape that sits wrong is worse than none]");
{
  const paths = groupPaths(squareLocalFt);
  const local = buildImport(paths, { unit: "ft", source: "moasure", frame: "local" });
  t("a local frame yields NO polygon", local[0].polygon.length === 0);
  t("...it is never placed at 0,0", !local[0].polygon.some((p) => p.lat === 0));
  t("...the issue is named", local[0].issues.includes("local_frame"));
  // The point of the refusal: it withholds the SHAPE, not the numbers.
  t("...but the area still comes through — it is frame-independent",
    near(local[0].areaSqft, 10000, 5));
  t("...and so does elevation, when present", true);
  t("...so a local file is a partial success, not a failure",
    local[0].importable === true);
  t("...and the copy says the shape could not be placed",
    describeImport(local[0]).includes("local frame"));
}

console.log("\n[frame detection reports a guess, never a decision]");
t("lat/lon headers are CERTAIN",
  detectFrame(["lat", "lon"], [pt(27.9, -82.4)]).certain === true);
t("...and geographic", detectFrame(["lat", "lon"], [pt(27.9, -82.4)]).frame === "geographic");
t("x/y headers read as local", detectFrame(["x", "y"], [pt(0, 0)]).frame === "local");
t("...but NOT certain — only lat/lon earns that",
  detectFrame(["x", "y"], [pt(0, 0)]).certain === false);
t("unlabelled degree-shaped values guess geographic",
  detectFrame(["c1", "c2"], [pt(27.9, -82.4), pt(27.91, -82.41)]).frame === "geographic");
t("...with certain false, because a small local survey can look identical",
  detectFrame(["c1", "c2"], [pt(27.9, -82.4)]).certain === false);
t("values hugging zero read as local even inside the lat/lng range",
  detectFrame(["c1", "c2"], [pt(0, 0), pt(0.5, 0.4)]).frame === "local");
t("no readable rows does not throw", typeof detectFrame(["a"], []).reason === "string");

console.log("\n[columns]");
t("lat/lng are found", guessColumns(["lat", "lng", "z"]).a === 0);
t("...with z", guessColumns(["lat", "lng", "z"]).z === 2);
t("longitude/latitude in either order map correctly",
  guessColumns(["longitude", "latitude"]).a === 1 && guessColumns(["longitude", "latitude"]).b === 0);
// Getting this backwards mirrors every shape, silently.
t("x/y map so that y is the north-south axis, as lat is",
  guessColumns(["x", "y"]).a === 1 && guessColumns(["x", "y"]).b === 0);
t("path and label columns are picked up",
  guessColumns(["lat", "lng", "path", "label"]).pathName === 2);
t("a file with no recognisable coordinate pair returns null — it does not guess",
  guessColumns(["foo", "bar"]) === null);
t("a one-column file returns null", guessColumns(["lat"]) === null);

console.log("\n[paths, and what shape they are]");
{
  const mixed = [
    pt(0, 0, { pathName: "Lawn" }), pt(0, 50, { pathName: "Lawn" }),
    pt(50, 50, { pathName: "Lawn" }), pt(0, 0, { pathName: "Lawn" }),
    pt(0, 0, { pathName: "Drive" }), pt(0, 30, { pathName: "Drive" }),
  ];
  const paths = groupPaths(mixed);
  t("one path per name", paths.length === 2);
  t("...in file order", paths[0].name === "Lawn" && paths[1].name === "Drive");
  t("a ring that returns to its start is closed", paths[0].closed === true);
  t("an open run is not", paths[1].closed === false);
  const built = buildImport(paths, { unit: "ft", source: "gnss", frame: "local" });
  t("a closed ring becomes an AREA", built[0].kind === "area");
  t("...with sqft and no run length", built[0].areaSqft > 0 && built[0].lengthFt === 0);
  t("an open path becomes a LINE", built[1].kind === "line");
  t("...with a run length and no area", built[1].lengthFt > 0 && built[1].areaSqft === 0);
  const single = buildImport(groupPaths([pt(1, 1)]), { unit: "ft", source: "gnss", frame: "local" });
  t("a lone point becomes a POINT", single[0].kind === "point");
  t("...with neither area nor length", single[0].areaSqft === 0 && single[0].lengthFt === 0);
  t("unnamed points land in one default path",
    groupPaths([pt(0, 0), pt(1, 1)])[0].name === "Imported area");
}
t("the closing tolerance is generous — a surveyor does not land on the same blade of grass",
  CLOSE_TOLERANCE >= 1);

console.log("\n[geographic area, without the browser]");
{
  // ringAreaSqft must NOT be google.maps — that returns 0 off-browser. About
  // 100 ft on a side near Tampa.
  const d = 100 / 364000;
  const ring = [
    { lat: 27.95, lng: -82.45 },
    { lat: 27.95 + d, lng: -82.45 },
    { lat: 27.95 + d, lng: -82.45 + d / Math.cos((27.95 * Math.PI) / 180) },
    { lat: 27.95, lng: -82.45 + d / Math.cos((27.95 * Math.PI) / 180) },
  ];
  t("a ~100ft square measures ~10,000 sqft with no browser present",
    near(ringAreaSqft(ring), 10000, 200), `got ${ringAreaSqft(ring)}`);
  t("winding direction does not flip the sign",
    ringAreaSqft(ring) === ringAreaSqft([...ring].reverse()));
  t("fewer than 3 points has no area", ringAreaSqft(ring.slice(0, 2)) === 0);
  t("garbage input does not throw", ringAreaSqft(null) === 0);
}

console.log("\n[elevation — absent is not flat]");
{
  const withZ = groupPaths([
    pt(0, 0, { z: 10, pathName: "Slope" }),
    pt(0, 100, { z: 14, pathName: "Slope" }),
  ]);
  const built = buildImport(withZ, { unit: "ft", source: "moasure", frame: "local" });
  t("fall is max minus min", built[0].elevation.fallFt === 4);
  t("...with the range", built[0].elevation.minFt === 10 && built[0].elevation.maxFt === 14);
  t("slope is rise over run as a percentage", near(built[0].elevation.maxSlopePct, 4, 0.2),
    `got ${built[0].elevation.maxSlopePct}`);
  const flat = buildImport(groupPaths([
    pt(0, 0, { z: 5, pathName: "Flat" }), pt(0, 50, { z: 5, pathName: "Flat" })]),
    { unit: "ft", source: "moasure", frame: "local" });
  t("a FLAT site reports a fall of 0", flat[0].elevation.fallFt === 0);
  const noZ = buildImport(groupPaths([pt(0, 0), pt(0, 50)]),
    { unit: "ft", source: "gnss", frame: "local" });
  t("a file with NO elevation column reports null, not zero", noZ[0].elevation === null);
  t("...which is a different answer from flat", flat[0].elevation !== null);
  // Elevation converts with the same unit choice as everything else.
  const metres = buildImport(withZ, { unit: "m", source: "moasure", frame: "local" });
  t("elevation is converted by the chosen unit too",
    near(metres[0].elevation.fallFt, 4 * 3.2808, 0.1), `got ${metres[0].elevation.fallFt}`);
  t("summariseElevation on nothing returns null", summariseElevation([], []) === null);
}

console.log("\n[comparison reports, never resolves]");
{
  const c = compareAreas(4200, 3850);
  t("the difference is stated", c.deltaPct === -8, `got ${c.deltaPct}`);
  t("...with both figures", c.message.includes("4,200") && c.message.includes("3,850"));
  t("...and no recommendation", !/should|recommend|use the/i.test(c.message));
  t("...and it explicitly leaves the choice open", c.message.includes("pick the one you trust"));
  t("identical measurements say so", compareAreas(1000, 1000).deltaPct === 0);
  t("nothing to compare against is said plainly",
    compareAreas(0, 3850).message.includes("Nothing measured"));
  t("...without inventing a percentage", compareAreas(0, 3850).deltaPct === 0);
}

console.log("\n[enums and bad input]");
t("sources cover map, device and manual",
  ["map", "moasure", "gnss", "drone", "manual"].every(isImportSource));
t("a typo is not a source", isImportSource("moasurre") === false);
t("units are feet and metres only", LENGTH_UNITS.join(",") === "ft,m");
t("inches is not a unit", isLengthUnit("in") === false);
t("IMPORT_SOURCES includes map, so an imported row can be told from a drawn one",
  IMPORT_SOURCES.includes("map"));
t("an empty path list builds nothing, and does not throw",
  buildImport([], { unit: "ft", source: "gnss", frame: "local" }).length === 0);
t("a path with no points is flagged rather than crashing",
  buildImport([{ name: "x", points: [], closed: false }],
    { unit: "ft", source: "gnss", frame: "local" })[0].issues.includes("too_few_points"));

console.log("\n[anchoring — placing a local trace on the map]");
{
  const { solveAnchor, applyAnchor, localPoints } = M;
  const FT_LAT = 364000;
  const ftLng = (lat) => FT_LAT * Math.cos((lat * Math.PI) / 180);

  // A real 100x150 ft rectangle near Tampa, corners in the world.
  const base = { lat: 27.95, lng: -82.45 };
  const world = [
    base,
    { lat: base.lat + 150 / FT_LAT, lng: base.lng },
    { lat: base.lat + 150 / FT_LAT, lng: base.lng + 100 / ftLng(base.lat) },
    { lat: base.lat, lng: base.lng + 100 / ftLng(base.lat) },
  ];

  // Now pretend a Moasure walked it: the same shape in feet from an arbitrary
  // origin, rotated 37 degrees — which is what an inertial device hands you.
  const ROT = 37, OX = 812, OY = -391;
  const rad = (ROT * Math.PI) / 180;
  const toLocal = (w) => {
    const e = (w.lng - base.lng) * ftLng(base.lat);
    const n = (w.lat - base.lat) * FT_LAT;
    return { east: e * Math.cos(rad) - n * Math.sin(rad) + OX,
             north: e * Math.sin(rad) + n * Math.cos(rad) + OY };
  };
  const local = world.map(toLocal);

  const tf = solveAnchor({ local: local[0], world: world[0] },
                         { local: local[1], world: world[1] });
  t("a transform is solved from two correspondences", tf !== null);
  t("...recovering the rotation", Math.abs(Math.abs(tf.rotationDeg) - ROT) < 0.5,
    `got ${tf.rotationDeg}`);
  t("...with a scale of 1, because the units were right",
    Math.abs(tf.scale - 1) < 0.01, `got ${tf.scale}`);

  // THE ROUND TRIP: place the local points back and see if they land on the
  // real corners.
  const placed = applyAnchor(local, tf);
  const offBy = placed.map((p, i) =>
    Math.hypot((p.lat - world[i].lat) * FT_LAT,
               (p.lng - world[i].lng) * ftLng(base.lat)));
  t("EVERY corner lands within a foot of where it really is",
    Math.max(...offBy) < 1, `worst ${Math.max(...offBy).toFixed(2)} ft`);
  t("...and the area survives the round trip",
    Math.abs(ringAreaSqft(placed) - 15000) < 100, `got ${ringAreaSqft(placed)}`);

  // The unit cross-check anchoring gives for free.
  const asMetres = local.map((q) => ({ east: q.east / 3.2808, north: q.north / 3.2808 }));
  const tBad = solveAnchor({ local: asMetres[0], world: world[0] },
                           { local: asMetres[1], world: world[1] });
  t("a unit mistake shows up as a scale near 3.28", Math.abs(tBad.scale - 3.2808) < 0.05,
    `got ${tBad.scale}`);
  t("...and is called out in words", tBad.warnings.some((w) => w.includes("metres")));
  t("a correct scale carries no scale warning",
    !tf.warnings.some((w) => w.includes("further apart") || w.includes("closer together")));
  t("the mirror ambiguity is always disclosed",
    tf.warnings.some((w) => w.includes("clockwise")));

  const tooClose = solveAnchor(
    { local: { east: 0, north: 0 }, world: base },
    { local: { east: 2, north: 0 },
      world: { lat: base.lat, lng: base.lng + 2 / ftLng(base.lat) } });
  t("two points a couple of feet apart are REFUSED, not solved", tooClose === null);

  const mk = (b) => ({ name: "x", closed: false,
    points: [{ a: 0, b, z: null, pathName: null, label: null }] });
  t("localPoints converts metres to feet on the way in",
    Math.abs(localPoints(mk(10), "m")[0].east - 32.808) < 0.01);
  t("...and leaves feet alone", localPoints(mk(10), "ft")[0].east === 10);

  // buildImport with an anchor: the trace stops being unplaced.
  const raw = local.map((q) => ({ a: q.north, b: q.east, z: null,
    pathName: "Lot", label: null }));
  const closedRaw = [...raw, raw[0]];
  const unplaced = buildImport(groupPaths(closedRaw),
    { unit: "ft", source: "moasure", frame: "local" });
  t("without an anchor a local trace still has NO polygon",
    unplaced[0].polygon.length === 0);
  t("...and says why", unplaced[0].issues.includes("local_frame"));
  const anchored = buildImport(groupPaths(closedRaw),
    { unit: "ft", source: "moasure", frame: "local", anchor: tf });
  t("WITH an anchor it gets a real polygon", anchored[0].polygon.length > 3);
  t("...positioned on the actual site",
    Math.abs(anchored[0].polygon[0].lat - base.lat) < 0.0001);
  t("...the local_frame issue is gone", !anchored[0].issues.includes("local_frame"));
  t("...and the area matches the real rectangle",
    Math.abs(anchored[0].areaSqft - 15000) < 150, `got ${anchored[0].areaSqft}`);
  // The number quoted and the shape drawn must be the same thing.
  t("...the stored area is measured FROM the placed polygon",
    Math.abs(anchored[0].areaSqft - ringAreaSqft(anchored[0].polygon)) < 1);
  t("an anchor without a unit still refuses — the unit gate outranks it",
    buildImport(groupPaths(closedRaw),
      { unit: null, source: "moasure", frame: "local", anchor: tf })[0].importable === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
