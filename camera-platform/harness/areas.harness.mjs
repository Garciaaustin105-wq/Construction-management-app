// harness/areas.harness.mjs — contracts/areas.ts
//
// FEARED: a 13th area on one busy camera silently accepted; a seated
// person's lower body (hidden by the desk) reading as "outside" because only
// the ground point was tested; a new edge rule invented here instead of
// reusing cameraAiSettings.ts's own pointInZone.

import { check, eq, same, report } from "./_assert.mjs";
import { MAX_AREAS_PER_CAMERA, MIN_AREA_POINTS, MAX_AREA_POINTS, checkArea, checkAreasFile, boxInsideArea } from "../dist/areas.js";

console.log("areas");

const DESK = [[0.2, 0.1], [0.8, 0.1], [0.8, 0.5], [0.2, 0.5]];

function area(id, cameraId, name, points = DESK) {
  return { id, cameraId, name, points };
}

// ---------------------------------------------------------------- validation

check("a good area is accepted", () => {
  const r = checkArea(area("a1", "cam1", "Manager's desk"), []);
  eq(r.ok, true);
  same(r.area, { id: "a1", cameraId: "cam1", name: "Manager's desk", points: DESK });
});

check("every field problem is listed, not just the first", () => {
  const r = checkArea({ id: "", cameraId: "", name: "  ", points: [] }, []);
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  eq(fields, ["cameraId", "id", "name", "points"]);
});

check("FEARED: a duplicate id is refused, even on a different camera", () => {
  const existing = [area("a1", "cam1", "Desk")];
  eq(checkArea(area("a1", "cam2", "Different name"), existing).ok, false);
  eq(checkArea(area("a1", "cam2", "Different name"), existing).errors[0].field, "id");
});

check("FEARED: the 13th area on one camera is refused; the 12th is not, and a 13th on ANOTHER camera is fine", () => {
  const twelve = Array.from({ length: MAX_AREAS_PER_CAMERA }, (_, i) => area(`a${i}`, "cam1", `Zone ${i}`));
  eq(checkArea(area("a12", "cam1", "One too many"), twelve).ok, false);
  eq(checkArea(area("a12", "cam1", "One too many"), twelve).errors[0].reason, "too_many_areas");
  eq(checkArea(area("a12", "cam2", "A different camera"), twelve).ok, true);
  // the 12th on cam1 (11 existing) is fine
  eq(checkArea(area("a11", "cam1", "Twelfth"), twelve.slice(0, 11)).ok, true);
});

check("point count and range are checked like a camera-ai zone", () => {
  const tooFew = checkArea(area("a1", "cam1", "Desk", [[0, 0], [1, 1]]), []);
  eq(tooFew.ok, false);
  eq(tooFew.errors[0].reason, "bad_point_count");
  const tooMany = checkArea(area("a1", "cam1", "Desk", Array.from({ length: MAX_AREA_POINTS + 1 }, (_, i) => [0, i / (MAX_AREA_POINTS + 1)])), []);
  eq(tooMany.ok, false);
  const outOfRange = checkArea(area("a1", "cam1", "Desk", [[0, 0], [1.2, 0], [1, 1]]), []);
  eq(outOfRange.ok, false);
  eq(outOfRange.errors[0].field, "points[1]");
  eq(MIN_AREA_POINTS, 3);
});

check("name is trimmed; a whitespace-only name is refused", () => {
  eq(checkArea(area("a1", "cam1", "  Manager's desk  "), []).area.name, "Manager's desk");
  eq(checkArea(area("a1", "cam1", "   "), []).ok, false);
});

// ---------------------------------------------------------------- whole-file validation

check("checkAreasFile validates the whole array, catching cross-area problems wherever they occur", () => {
  const raw = {
    version: 1,
    areas: [
      area("a1", "cam1", "Desk"),
      area("a2", "cam1", "Parking spot", [[0, 0.6], [1, 0.6], [1, 1]]),
      area("a1", "cam2", "Duplicate id"),
    ],
  };
  const r = checkAreasFile(raw);
  eq(r.ok, false);
  eq(r.errors.length, 1);
  eq(r.errors[0], { index: 2, field: "id", reason: "duplicate_id" });
});

check("checkAreasFile accepts a clean file and refuses a bad shape", () => {
  const good = checkAreasFile({ version: 1, areas: [area("a1", "cam1", "Desk")] });
  eq(good.ok, true);
  eq(good.file.areas.length, 1);
  eq(checkAreasFile({ version: 2, areas: [] }).ok, false);
  eq(checkAreasFile({ version: 1, areas: "nope" }).ok, false);
  eq(checkAreasFile(null).ok, false);
});

// ---------------------------------------------------------------- the inside test

check("the bottom-centre point decides for a person standing in the open", () => {
  const box = { x: 0.4, y: 0.2, w: 0.1, h: 0.2 }; // feet at (0.45, 0.4): inside DESK
  eq(boxInsideArea(box, DESK), true);
  const outside = { x: 0.4, y: 0.6, w: 0.1, h: 0.2 }; // feet at (0.45, 0.8): below DESK
  eq(boxInsideArea(outside, DESK), false);
});

check("FEARED: only the top 60% of the box inside still counts (the desk hides the legs)", () => {
  // top 60% inside DESK, bottom 40% below it: feet clearly outside.
  const box = { x: 0.4, y: 0.26, w: 0.1, h: 0.4 }; // y in [0.26, 0.66]; inside portion [0.26,0.5] = 0.24/0.4 = 60%
  eq(boxInsideArea(box, DESK), true);
  eq(boxInsideArea({ x: 0.4, y: 0.2, w: 0.1, h: 0.2 }, DESK), true); // sanity: fully inside
});

check("exactly 40% inside, feet outside, still counts (the threshold is inclusive)", () => {
  // 5x5 grid: rows at y = 0.34 + {0.042,0.126,0.21,0.294,0.378}; two of the
  // five (0.382, 0.466) fall inside DESK's y <= 0.5, the other three do not.
  const box = { x: 0.4, y: 0.34, w: 0.1, h: 0.42 };
  eq(boxInsideArea(box, DESK), true);
});

check("under 40% inside, feet outside, does not count", () => {
  // inside portion [0.4,0.5] out of [0.4,1.0] height 0.6; on the 5x5 grid
  // only the first row (y=0.46) lands inside DESK: 1/5 = 20%.
  const box = { x: 0.4, y: 0.4, w: 0.1, h: 0.6 };
  eq(boxInsideArea(box, DESK), false);
});

check("a point exactly on the area's edge counts as inside (reused from cameraAiSettings.ts, not re-derived)", () => {
  const onEdge = { x: 0.4, y: 0.0, w: 0.1, h: 0.1 }; // feet at (0.45, 0.1): DESK's own top edge
  eq(boxInsideArea(onEdge, DESK), true);
});

report("areas");
