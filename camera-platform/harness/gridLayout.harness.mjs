/**
 * The camera wall's layout maths.
 *
 * The failure it exists to prevent (build rule 19): a 4x4 wall with five
 * cameras draws eleven black rectangles, and a black rectangle on a TV in a
 * car wash office looks exactly like a dead camera. Staff ring the installer
 * out for a fault that is not there. So this contract must never express an
 * empty cell as an absence -- it is a labelled thing, in the data, with an
 * index, every time.
 *
 * The other failures checked here: a wall left on page 3 going blank when
 * cameras are removed; "page 1 of 0"; a blank cameraId shuffling every camera
 * after it into the wrong slot; and a shared shapes table a caller can edit.
 */
import { GRID_SHAPES, gridShape, gridPage, cellAspectRatio } from "../dist/gridLayout.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("gridLayout");

const ids = (n, prefix = "cam") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const kinds = (page) => page.cells.map((c) => c.kind);
const filled = (page) => page.cells.filter((c) => c.kind === "camera").map((c) => c.cameraId);

check("the four shapes are what a wall can be, and their arithmetic holds", () => {
  eq(GRID_SHAPES.map((s) => s.id), ["1x1", "2x2", "3x3", "4x4"], "ids in order");
  for (const s of GRID_SHAPES) {
    eq(s.cells, s.columns * s.rows, `${s.id}: cells === columns * rows`);
  }
  eq(gridShape("4x4").cells, 16, "4x4");
  eq(gridShape("1x1").cells, 1, "1x1");
});

check("a wall always has exactly as many cells as its shape", () => {
  for (const shape of GRID_SHAPES) {
    for (const n of [0, 1, 3, 5, 16, 40]) {
      const page = gridPage({ cameraIds: ids(n), layout: shape.id });
      eq(page.cells.length, shape.cells, `${shape.id} with ${n} cameras`);
      same(page.cells.map((c) => c.index), page.cells.map((_, i) => i), `${shape.id}: indexes 0..n-1 in order`);
    }
  }
});

check("the eleven black rectangles are labelled empty, not missing", () => {
  const page = gridPage({ cameraIds: ids(5), layout: "4x4" });
  eq(page.cells.length, 16, "every cell present");
  eq(kinds(page).filter((k) => k === "camera").length, 5, "five cameras");
  eq(kinds(page).filter((k) => k === "empty").length, 11, "eleven EMPTY cells, each one a thing the UI can label");
  eq(filled(page), ids(5), "in the installer's order");
  for (const cell of page.cells) {
    if (cell.kind !== "camera" && cell.kind !== "empty") {
      throw new Error(`a cell must be camera or empty, got ${JSON.stringify(cell)}`);
    }
    if (cell.kind === "empty" && "cameraId" in cell) {
      throw new Error("an empty cell must not carry a cameraId");
    }
  }
});

check("a wall with no cameras is one empty page, never page 1 of 0", () => {
  const page = gridPage({ cameraIds: [], layout: "3x3" });
  eq(page.pageCount, 1, "pageCount is never 0");
  eq(page.pageIndex, 0, "on the first page");
  eq(page.cameraCount, 0, "and honest about having none");
  eq(kinds(page), Array(9).fill("empty"), "nine empty cells");
});

check("paging: nine cameras on a 2x2 wall is three pages, the last half full", () => {
  const nine = ids(9);
  const p0 = gridPage({ cameraIds: nine, layout: "2x2", page: 0 });
  const p1 = gridPage({ cameraIds: nine, layout: "2x2", page: 1 });
  const p2 = gridPage({ cameraIds: nine, layout: "2x2", page: 2 });
  eq(p0.pageCount, 3, "ceil(9/4)");
  eq(filled(p0), ["cam1", "cam2", "cam3", "cam4"], "page 0");
  eq(filled(p1), ["cam5", "cam6", "cam7", "cam8"], "page 1");
  eq(filled(p2), ["cam9"], "page 2 holds the remainder");
  eq(kinds(p2), ["camera", "empty", "empty", "empty"], "and pads the rest");
  eq(p2.cameraCount, 9, "cameraCount is the total, not this page's count");
});

check("a page number out of range lands on a real page instead of going blank", () => {
  const four = ids(4);
  // The wall was left on page 3; someone removed cameras. It must not go dark.
  eq(gridPage({ cameraIds: four, layout: "2x2", page: 3 }).pageIndex, 0, "clamped down to the last page");
  eq(filled(gridPage({ cameraIds: four, layout: "2x2", page: 99 })), four, "and still shows the cameras");
  eq(gridPage({ cameraIds: ids(9), layout: "2x2", page: 99 }).pageIndex, 2, "clamped to the last page, not the first");
  eq(gridPage({ cameraIds: four, layout: "2x2", page: -4 }).pageIndex, 0, "negative clamps to 0");
  eq(gridPage({ cameraIds: ids(9), layout: "2x2", page: 2.7 }).pageIndex, 2, "a fraction floors before it clamps");
  eq(gridPage({ cameraIds: four, layout: "2x2", page: Number.NaN }).pageIndex, 0, "NaN is page 0, not an empty wall");
  eq(gridPage({ cameraIds: four, layout: "2x2" }).pageIndex, 0, "omitted page defaults to 0");
});

check("a duplicate camera is drawn twice, because the installer put it there twice", () => {
  const page = gridPage({ cameraIds: ["cam1", "cam1", "cam2"], layout: "2x2" });
  eq(filled(page), ["cam1", "cam1", "cam2"], "no silent deduplication");
  eq(page.cameraCount, 3, "and it counts");
});

check("a blank id empties its own slot without moving anyone else", () => {
  const page = gridPage({ cameraIds: ["cam1", "", "  ", "cam2"], layout: "2x2" });
  eq(kinds(page), ["camera", "empty", "empty", "camera"], "the blanks stay where they were put");
  const last = page.cells[3];
  if (last === undefined || last.kind !== "camera" || last.cameraId !== "cam2") {
    throw new Error(`cam2 must still be in slot 3, got ${JSON.stringify(last)}`);
  }
  eq(page.cameraCount, 4, "a blank still occupies a slot in the caller's list");
});

check("the caller's list comes back unchanged", () => {
  const cameraIds = ["cam3", "cam1", "cam2"];
  const snapshot = [...cameraIds];
  const input = { cameraIds, layout: "2x2", page: 0 };
  gridPage(input);
  same(cameraIds, snapshot, "order untouched -- a wall is not sorted behind the installer's back");
  same(input, { cameraIds: snapshot, layout: "2x2", page: 0 }, "input untouched");
});

check("editing a returned shape cannot change the next wall", () => {
  const shape = gridShape("2x2");
  try { shape.cells = 99; } catch { /* frozen is also a correct answer */ }
  eq(gridShape("2x2").cells, 4, "the shapes table survived");
  eq(gridPage({ cameraIds: ids(4), layout: "2x2" }).cells.length, 4, "and so did the wall");
});

check("a cell holds a camera's shape, so nothing gets stretched into a van", () => {
  for (const s of GRID_SHAPES) eq(cellAspectRatio(s), "16 / 9", `${s.id}`);
});

report("gridLayout");
