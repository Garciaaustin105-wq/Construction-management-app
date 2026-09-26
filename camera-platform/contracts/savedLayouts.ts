/**
 * Saved wall layouts: named per-account layouts (the Live page) and one
 * layout per paired display (the Accounts page) — SITE-SETTINGS-SPEC.md,
 * section 3. Pure: no I/O, no clock. `<stateDir>/layouts.json` and
 * `<stateDir>/display-layouts.json`, their read/write and their audit lines
 * belong to agent/ — the same split contracts/cameraAiSettings.ts keeps from
 * agent/camera-ai-settings.mjs.
 *
 * A SAVED layout is not contracts/gridLayout.mts's own `gridPage` (the wall's
 * auto-paging of every configured camera, in whatever order the installer
 * listed them). It is the opposite: an installer or a store account places
 * SPECIFIC cameras into SPECIFIC cells by hand, so the stored shape is one
 * cell per index, `null` for an empty one — never a shorter list a reader has
 * to pad out, and never gridPage's own paging maths, which answers a
 * different question (how many pages does every configured camera need).
 *
 * THE FEARED FAILURES, by name:
 * - one account reading or writing a slice of layouts.json that names
 *   another account — "Other accounts' layouts are never visible or
 *   editable" — so every helper here takes and returns ONE account's own
 *   slice, never the whole file, making the wrong operation (touching
 *   `file.accounts` directly) the one that stands out in a diff, not the
 *   quiet default;
 * - a camera removed from config.cameras leaving its old cell looking
 *   exactly like one that was always empty — "renders as an explicit
 *   'camera removed' cell, never a silent blank" (build rule 5's own
 *   sibling: a blank is not a zero, and here a REMOVAL is not a blank
 *   either);
 * - a cell count that silently drifts from the chosen shape's own
 *   `GridShape.cells` (contracts/gridLayout.mts) — a layout saved for "3x3"
 *   with 8 cells stored would either drop a camera or, read back, place one
 *   in a cell the shape does not have;
 * - a display's own single layout being editable through the same door a
 *   named per-account layout is — SITE-SETTINGS-SPEC.md: "A display never
 *   edits it" — enforced here by giving a display assignment its own
 *   validator with no "default" and no per-account map to reach through.
 */

import { GRID_SHAPES, type GridLayoutId } from "./gridLayout.mjs";

// ---------------------------------------------------------------- constants

export const LAYOUTS_VERSION = 1;
export const DISPLAY_LAYOUTS_VERSION = 1;

/** A generous ceiling on how many named layouts one account can keep — not
 *  from the spec (which sets none), a sanity bound so a scripted client
 *  cannot grow one account's slice without limit. */
export const MAX_LAYOUTS_PER_ACCOUNT = 50;

/** Matches cameraEdit.ts's own `name` rule for a camera's display name — the
 *  same shape of free-text field, a different owner. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_LAYOUT_NAME_LENGTH = 60;

const GRID_LAYOUT_IDS: ReadonlySet<string> = new Set(GRID_SHAPES.map((s) => s.id));

function cellsForShape(layout: GridLayoutId): number {
  const shape = GRID_SHAPES.find((s) => s.id === layout);
  // Guarded by isGridLayoutId at every call site below; a caller reaching
  // this with an id GRID_SHAPES does not list is a bug in THIS file, not
  // data an installer typed.
  if (shape === undefined) throw new TypeError(`cellsForShape: unknown grid layout id ${JSON.stringify(layout)}`);
  return shape.cells;
}

function isGridLayoutId(v: unknown): v is GridLayoutId {
  return typeof v === "string" && GRID_LAYOUT_IDS.has(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- shapes

/** One cell's stored value: a camera id, or `null` for an explicitly empty
 *  cell. Index in the array IS the cell index — a shorter array is a
 *  validation error (bad_cell_count), never padded out with implicit blanks. */
export type LayoutCells = ReadonlyArray<string | null>;

export interface NamedLayout {
  name: string;
  layout: GridLayoutId;
  cells: LayoutCells;
}

export interface AccountLayouts {
  layouts: readonly NamedLayout[];
  /** The name of one of `layouts`, or null when none is set as default yet. */
  defaultName: string | null;
}

export interface LayoutsFile {
  version: 1;
  /** username -> that account's own layouts. Never read or written as a
   *  whole by anything other than the scoping helpers below. */
  accounts: Readonly<Record<string, AccountLayouts>>;
}

export interface DisplayLayout {
  layout: GridLayoutId;
  cells: LayoutCells;
}

export interface DisplayLayoutsFile {
  version: 1;
  /** displayId -> the one layout assigned to it. A display has no "default":
   *  it shows exactly the layout here, or nothing until one is assigned. */
  displays: Readonly<Record<string, DisplayLayout>>;
}

// ---------------------------------------------------------------- shared cell/name validation

export interface FieldProblem {
  field: string;
  reason: string;
}

/** `cells` against `layout`'s own shape: every entry a string camera id or
 *  null, and EXACTLY as many entries as the shape has cells — not fewer
 *  (an installer who never touched a trailing cell must still get an
 *  explicit empty one back, never a cell the reader has to invent) and not
 *  more (an extra entry names a cell this shape does not have at all). */
function checkCells(layout: GridLayoutId, raw: unknown, errors: FieldProblem[]): LayoutCells {
  const wanted = cellsForShape(layout);
  if (!Array.isArray(raw)) {
    errors.push({ field: "cells", reason: "not_an_array" });
    return Array.from({ length: wanted }, () => null);
  }
  if (raw.length !== wanted) {
    errors.push({ field: "cells", reason: "bad_cell_count" });
  }
  const cells: (string | null)[] = [];
  const n = Math.min(raw.length, wanted);
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (v === null) {
      cells.push(null);
    } else if (typeof v === "string" && v !== "") {
      cells.push(v);
    } else {
      errors.push({ field: `cells[${i}]`, reason: "bad_cell_value" });
      cells.push(null);
    }
  }
  while (cells.length < wanted) cells.push(null);
  return cells;
}

function checkLayoutId(raw: unknown, errors: FieldProblem[]): GridLayoutId {
  if (!isGridLayoutId(raw)) {
    errors.push({ field: "layout", reason: "bad_layout_id" });
    // "2x2" is a real shape every wall can render — a fallback only so the
    // rest of this validation can still describe the cells it was given;
    // the caller sees bad_layout_id in `errors` regardless and refuses the
    // whole save (SiteSettingsCheck's own sibling rule: never the first
    // problem alone).
    return "2x2";
  }
  return raw;
}

// ---------------------------------------------------------------- named layouts (per account)

export type NamedLayoutCheck = { ok: true; layout: NamedLayout } | { ok: false; errors: FieldProblem[] };

/**
 * Validate one named layout's own shape against contracts/gridLayout.mts —
 * NOT against the current camera list (see resolveLayoutCells below for
 * that): a layout naming a camera that is offline, or temporarily removed
 * and about to come back, is still a perfectly valid SAVE. Every problem is
 * reported at once.
 */
export function checkNamedLayout(raw: unknown): NamedLayoutCheck {
  if (!isRecord(raw)) return { ok: false, errors: [{ field: "layout", reason: "not_an_object" }] };
  const errors: FieldProblem[] = [];
  let name: string;
  if (typeof raw.name !== "string" || CONTROL.test(raw.name) || raw.name.trim() === "" || raw.name.trim().length > MAX_LAYOUT_NAME_LENGTH) {
    errors.push({ field: "name", reason: "bad_name" });
    name = "";
  } else {
    name = raw.name.trim();
  }
  const layoutId = checkLayoutId(raw.layout, errors);
  const cells = checkCells(layoutId, raw.cells, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, layout: { name, layout: layoutId, cells } };
}

export type AccountLayoutsCheck = { ok: true; account: AccountLayouts } | { ok: false; errors: FieldProblem[] };

/**
 * Validate a whole account's own slice: every named layout (duplicate names
 * refused — a picker cannot show the installer two layouts with the same
 * label), the cap on how many exist, and a `defaultName` that names one of
 * them (or null).
 */
export function checkAccountLayouts(raw: unknown): AccountLayoutsCheck {
  if (!isRecord(raw)) return { ok: false, errors: [{ field: "account", reason: "not_an_object" }] };
  const errors: FieldProblem[] = [];
  const rawLayouts = raw.layouts;
  if (!Array.isArray(rawLayouts)) {
    errors.push({ field: "layouts", reason: "not_an_array" });
    return { ok: false, errors };
  }
  if (rawLayouts.length > MAX_LAYOUTS_PER_ACCOUNT) {
    errors.push({ field: "layouts", reason: "too_many_layouts" });
  }
  const layouts: NamedLayout[] = [];
  const seen = new Set<string>();
  rawLayouts.forEach((entry: unknown, i: number) => {
    const check = checkNamedLayout(entry);
    if (!check.ok) {
      for (const e of check.errors) errors.push({ field: `layouts[${i}].${e.field}`, reason: e.reason });
      return;
    }
    if (seen.has(check.layout.name)) {
      errors.push({ field: `layouts[${i}].name`, reason: "duplicate_layout_name" });
      return;
    }
    seen.add(check.layout.name);
    layouts.push(check.layout);
  });
  let defaultName: string | null = null;
  if (raw.defaultName !== undefined && raw.defaultName !== null) {
    if (typeof raw.defaultName !== "string" || !seen.has(raw.defaultName)) {
      errors.push({ field: "defaultName", reason: "bad_default_name" });
    } else {
      defaultName = raw.defaultName;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, account: { layouts, defaultName } };
}

// ---------------------------------------------------------------- per-account scoping

/** An account's own slice, or the honest empty one when it has never saved a
 *  layout — never `undefined`, so a caller cannot forget the null case and
 *  crash reading `.layouts` off it. */
export function accountLayouts(file: LayoutsFile, username: string): AccountLayouts {
  // A plain object's `[key]` lookup answers with an INHERITED
  // Object.prototype member (a function, so truthy) for a key like
  // "constructor" or "toString" even when that key was never actually
  // saved -- `?? default` never fires for those, so a username matching one
  // of Object.prototype's own property names would silently get back a
  // built-in function instead of the promised default, and `.layouts` off
  // it would be `undefined` (exactly the crash this function's own doc
  // comment says can never happen). validateName (contracts/access.ts)
  // allows "constructor" as a username -- only "_"-leading names like
  // "__proto__" are rejected -- so this is reachable with an ordinary
  // account name, not just a crafted file. hasOwnProperty sidesteps the
  // prototype chain entirely: only a key this file's own writes actually
  // stored ever counts as "found".
  if (!Object.prototype.hasOwnProperty.call(file.accounts, username)) {
    return { layouts: [], defaultName: null };
  }
  // hasOwnProperty just confirmed this key was actually written (never an
  // inherited Object.prototype member), so the lookup below can only be
  // undefined if TypeScript's index-signature type is wrong about that --
  // which is exactly what the check above rules out at runtime.
  return file.accounts[username] as AccountLayouts;
}

/**
 * The one, and only, way to write an account's slice back: every OTHER
 * account's entry is carried over untouched, and only `username`'s own key
 * changes — so "did this save touch someone else's layouts" is answered by
 * this function's own body, once, rather than by every call site getting it
 * right on its own.
 */
export function withAccountLayouts(file: LayoutsFile, username: string, next: AccountLayouts): LayoutsFile {
  return { version: LAYOUTS_VERSION, accounts: { ...file.accounts, [username]: next } };
}

export function emptyLayoutsFile(): LayoutsFile {
  return { version: LAYOUTS_VERSION, accounts: {} };
}

export type SetDefaultResult = { ok: true; account: AccountLayouts } | { ok: false; reason: string };

/** Mark one of an account's own layouts as its default — refused (not
 *  guessed at) when `name` does not name a layout this account actually
 *  has, so a stale or mistyped name can never silently become "no default"
 *  or point at nothing. */
export function setDefaultLayout(account: AccountLayouts, name: string): SetDefaultResult {
  if (!account.layouts.some((l) => l.name === name)) {
    return { ok: false, reason: "no_such_layout" };
  }
  return { ok: true, account: { layouts: account.layouts, defaultName: name } };
}

/** The account's own default layout, or null when none is set, or when
 *  `defaultName` names a layout that is no longer there (an inconsistency
 *  this file's own validated writes never produce, but a reader must still
 *  answer honestly rather than throw on a file it did not write). */
export function defaultLayoutFor(account: AccountLayouts): NamedLayout | null {
  if (account.defaultName === null) return null;
  return account.layouts.find((l) => l.name === account.defaultName) ?? null;
}

// ---------------------------------------------------------------- resolving cells against the camera list

export type ResolvedLayoutCell =
  | { kind: "camera"; index: number; cameraId: string }
  | { kind: "empty"; index: number }
  /** A camera id this layout still names, that no longer exists — "renders
   *  as an explicit 'camera removed' cell, never a silent blank." */
  | { kind: "removed"; index: number; cameraId: string };

/**
 * `cells` resolved against the CURRENT camera list — the read-side half of
 * "camera removed": a save never needs the camera list at all (checkCells
 * above validates shape only), but every render does, because a camera can
 * be removed at any moment after a layout was saved.
 */
export function resolveLayoutCells(cells: LayoutCells, currentCameraIds: ReadonlySet<string> | readonly string[]): ResolvedLayoutCell[] {
  const known = currentCameraIds instanceof Set ? currentCameraIds : new Set(currentCameraIds);
  return cells.map((cameraId, index) => {
    if (cameraId === null) return { kind: "empty", index };
    if (!known.has(cameraId)) return { kind: "removed", index, cameraId };
    return { kind: "camera", index, cameraId };
  });
}

// ---------------------------------------------------------------- display layout assignments

export type DisplayLayoutCheck = { ok: true; layout: DisplayLayout } | { ok: false; errors: FieldProblem[] };

/**
 * Validate one display's assigned layout — shape and cameras only, exactly
 * like checkNamedLayout, but with no `name` and no default: "A display never
 * edits it", so nothing here ever needs a name to show in a picker, and
 * there is exactly one layout per display, never a list to choose among.
 */
export function checkDisplayLayout(raw: unknown): DisplayLayoutCheck {
  if (!isRecord(raw)) return { ok: false, errors: [{ field: "layout", reason: "not_an_object" }] };
  const errors: FieldProblem[] = [];
  const layoutId = checkLayoutId(raw.layout, errors);
  const cells = checkCells(layoutId, raw.cells, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, layout: { layout: layoutId, cells } };
}

export function emptyDisplayLayoutsFile(): DisplayLayoutsFile {
  return { version: DISPLAY_LAYOUTS_VERSION, displays: {} };
}

/** One display's own layout, or null when the installer has never assigned
 *  it one yet — the wall shows nothing until then, never a guessed shape. */
export function displayLayout(file: DisplayLayoutsFile, displayId: string): DisplayLayout | null {
  // Same prototype-chain trap as accountLayouts above: a displayId like
  // "constructor" is a legal name (validateName allows it) and `?? null`
  // never fires for it, since the inherited Object.prototype member is
  // truthy. hasOwnProperty makes only an actually-assigned displayId count.
  if (!Object.prototype.hasOwnProperty.call(file.displays, displayId)) return null;
  return file.displays[displayId] as DisplayLayout;
}

/** The one way to write a display's assignment back: every OTHER display's
 *  entry is carried over untouched — the same discipline withAccountLayouts
 *  keeps for a per-account write, applied to displays instead of accounts. */
export function withDisplayLayout(file: DisplayLayoutsFile, displayId: string, next: DisplayLayout): DisplayLayoutsFile {
  return { version: DISPLAY_LAYOUTS_VERSION, displays: { ...file.displays, [displayId]: next } };
}
