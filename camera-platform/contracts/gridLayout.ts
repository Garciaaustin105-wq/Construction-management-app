/**
 * Where the cameras go on a wall of TVs.
 *
 * The failure this exists to prevent: a 4x4 wall with five cameras draws
 * eleven black rectangles, and on a TV in a car wash office a black rectangle
 * looks exactly like a dead camera. Staff ring the installer out for a fault
 * that was never there. So an empty cell is never an absence here -- it is a
 * cell, with an index, that says "empty", and the UI has something to label.
 */

export type GridLayoutId = "1x1" | "2x2" | "3x3" | "4x4";

export interface GridShape {
  id: GridLayoutId;
  columns: number;
  rows: number;
  cells: number; // columns * rows
}

/**
 * The shapes a wall can be. Exported so the UI's buttons are generated from
 * the contract and cannot drift from what gridPage will actually lay out.
 * Frozen at both levels: a caller that edits this array would change every
 * wall in the process, including ones already on screen.
 */
export const GRID_SHAPES: readonly GridShape[] = Object.freeze([
  Object.freeze({ id: "1x1", columns: 1, rows: 1, cells: 1 }),
  Object.freeze({ id: "2x2", columns: 2, rows: 2, cells: 4 }),
  Object.freeze({ id: "3x3", columns: 3, rows: 3, cells: 9 }),
  Object.freeze({ id: "4x4", columns: 4, rows: 4, cells: 16 }),
] as const);

/**
 * Refuses an unknown layout rather than picking a default. A wall that
 * silently falls back to 2x2 hides the typo that caused it.
 * Returns a copy, so the caller cannot edit the table through it.
 */
export function gridShape(id: GridLayoutId): GridShape {
  const shape = GRID_SHAPES.find((s) => s.id === id);
  if (shape === undefined) throw new Error(`unknown grid layout: ${id}`);
  return { ...shape };
}

export interface GridCellFilled {
  kind: "camera";
  index: number; // 0-based position in the page
  cameraId: string;
}
export interface GridCellEmpty {
  kind: "empty";
  index: number;
}
export type GridCell = GridCellFilled | GridCellEmpty;

export interface GridPage {
  shape: GridShape;
  pageIndex: number; // 0-based
  pageCount: number; // ALWAYS >= 1, even with no cameras at all
  cells: GridCell[]; // length ALWAYS === shape.cells
  cameraCount: number; // how many cameras exist in total, not on this page
}

export interface GridLayoutInput {
  cameraIds: readonly string[];
  layout: GridLayoutId;
  page?: number; // defaults to 0
}

/**
 * Refuses to return a short page, a page count of zero, or a page index the
 * caller cannot render. An out-of-range page is clamped, never rejected: a
 * wall left on page 3 when cameras are removed must land on the last real
 * page, not go dark and blame whoever is standing in front of it.
 *
 * It also refuses to tidy the caller's list. Duplicates are drawn twice and
 * blanks hold their slot, because the order an installer set is the wall.
 */
export function gridPage(input: GridLayoutInput): GridPage {
  const shape = gridShape(input.layout);
  const cameraIds = input.cameraIds;
  const cameraCount = cameraIds.length;
  const pageCount = Math.max(1, Math.ceil(cameraCount / shape.cells));

  // Floor before clamping: 2.7 is page 2, not page 3. NaN survives the floor
  // and is caught here, so a broken query string lands on page 0.
  let pageIndex = Math.floor(input.page ?? 0);
  if (Number.isNaN(pageIndex)) pageIndex = 0;
  if (pageIndex < 0) pageIndex = 0;
  if (pageIndex >= pageCount) pageIndex = pageCount - 1;

  const start = pageIndex * shape.cells;
  const cells: GridCell[] = [];
  for (let i = 0; i < shape.cells; i++) {
    const id = cameraIds[start + i];
    // A blank id is not a camera, but it still owns its slot -- shuffling the
    // rest up would move every camera after it out of the place it was put.
    if (id === undefined || id.trim() === "") cells.push({ kind: "empty", index: i });
    else cells.push({ kind: "camera", index: i, cameraId: id });
  }

  return { shape, pageIndex, pageCount, cells, cameraCount };
}

/**
 * The CSS aspect ratio a wall cell should hold. A 16:9 camera stretched to
 * fill a 4:3 cell makes every car look like a van, and the first thing an
 * installer does about that is start changing camera settings that were
 * right. It takes the shape so no caller hardcodes the ratio at the call
 * site; when a 4:3 camera has to share a wall, the answer changes here only.
 */
export function cellAspectRatio(_shape: GridShape): string {
  return "16 / 9";
}
