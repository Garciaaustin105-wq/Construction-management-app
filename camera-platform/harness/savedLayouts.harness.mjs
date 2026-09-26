// harness/savedLayouts.harness.mjs — contracts/savedLayouts.ts
// (SITE-SETTINGS-SPEC.md, section 3)
//
// NOT REGISTERED in harness/run-all.mjs (new harnesses never are — see
// AGENTS.md); run it directly: `node harness/savedLayouts.harness.mjs`.
//
// FEARED: one account reading or writing another account's layouts; a
// removed camera's old cell rendering as an ordinary empty cell instead of an
// explicit "camera removed"; a cell count silently drifting from the chosen
// shape's own cell count; a display's layout being reachable through the
// per-account door.

import { check, eq, same, report } from "./_assert.mjs";
import {
  MAX_LAYOUT_NAME_LENGTH, MAX_LAYOUTS_PER_ACCOUNT,
  checkNamedLayout, checkAccountLayouts,
  accountLayouts, withAccountLayouts, emptyLayoutsFile,
  setDefaultLayout, defaultLayoutFor,
  resolveLayoutCells,
  checkDisplayLayout, emptyDisplayLayoutsFile, displayLayout, withDisplayLayout,
} from "../dist/savedLayouts.js";
import { GRID_SHAPES } from "../dist/gridLayout.mjs";

console.log("saved layouts");

const cells4 = (a = null, b = null, c = null, d = null) => [a, b, c, d]; // "2x2" shape

// ---------------------------------------------------------------- named layout validation

check("a well-formed named layout validates, cells kept in index order", () => {
  const r = checkNamedLayout({ name: "Front counter", layout: "2x2", cells: cells4("cam-1", null, "cam-2", null) });
  eq(r.ok, true);
  same(r.layout, { name: "Front counter", layout: "2x2", cells: ["cam-1", null, "cam-2", null] });
});

check("a blank, over-long or control-character name is refused, never silently truncated", () => {
  eq(checkNamedLayout({ name: "   ", layout: "2x2", cells: cells4() }).ok, false);
  eq(checkNamedLayout({ name: "x".repeat(MAX_LAYOUT_NAME_LENGTH + 1), layout: "2x2", cells: cells4() }).ok, false);
  eq(checkNamedLayout({ name: "bad\u0007name", layout: "2x2", cells: cells4() }).ok, false);
});

check("an unknown grid layout id is refused, never silently coerced to a real shape", () => {
  const r = checkNamedLayout({ name: "x", layout: "7x7", cells: [] });
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "layout" && e.reason === "bad_layout_id"), true);
});

check("REQUIRED: cells must be exactly as many as the chosen shape has, not fewer and not more", () => {
  const shortOne = checkNamedLayout({ name: "x", layout: "2x2", cells: ["cam-1"] });
  eq(shortOne.ok, false);
  eq(shortOne.errors.some((e) => e.field === "cells" && e.reason === "bad_cell_count"), true);

  const longOne = checkNamedLayout({ name: "x", layout: "2x2", cells: [null, null, null, null, "cam-1"] });
  eq(longOne.ok, false);
  eq(longOne.errors.some((e) => e.field === "cells" && e.reason === "bad_cell_count"), true);

  for (const shape of GRID_SHAPES) {
    const ok = checkNamedLayout({ name: shape.id, layout: shape.id, cells: Array.from({ length: shape.cells }, () => null) });
    eq(ok.ok, true, `${shape.id}: exactly ${shape.cells} cells accepted`);
  }
});

check("a non-string, empty-string or otherwise bad cell value is refused by its own index, never silently dropped", () => {
  const r = checkNamedLayout({ name: "x", layout: "2x2", cells: ["cam-1", "", 5, null] });
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["cells[1]", "cells[2]"]);
});

check("every problem in a bad named layout comes back at once", () => {
  const r = checkNamedLayout({ name: "", layout: "9x9", cells: ["cam-1"] });
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  same(fields, ["cells", "layout", "name"]);
});

check("checkNamedLayout refuses a non-object outright", () => {
  for (const bad of [null, undefined, [], "x", 1]) {
    eq(checkNamedLayout(bad).ok, false);
  }
});

// ---------------------------------------------------------------- an account's whole slice

check("checkAccountLayouts accepts a good slice, including its default", () => {
  const r = checkAccountLayouts({
    layouts: [
      { name: "Front", layout: "2x2", cells: cells4("cam-1", null, null, null) },
      { name: "Back", layout: "1x1", cells: [null] },
    ],
    defaultName: "Front",
  });
  eq(r.ok, true);
  eq(r.account.layouts.length, 2);
  eq(r.account.defaultName, "Front");
});

check("REQUIRED: two layouts sharing one name in the same account are refused, never silently kept as duplicates", () => {
  const r = checkAccountLayouts({
    layouts: [
      { name: "Front", layout: "2x2", cells: cells4() },
      { name: "Front", layout: "1x1", cells: [null] },
    ],
    defaultName: null,
  });
  eq(r.ok, false);
  eq(r.errors.some((e) => e.reason === "duplicate_layout_name"), true);
});

check("a defaultName that does not name any of this account's own layouts is refused, never silently cleared", () => {
  const r = checkAccountLayouts({
    layouts: [{ name: "Front", layout: "2x2", cells: cells4() }],
    defaultName: "Nonexistent",
  });
  eq(r.ok, false);
  same(r.errors, [{ field: "defaultName", reason: "bad_default_name" }]);
});

check("more layouts than MAX_LAYOUTS_PER_ACCOUNT is refused", () => {
  const layouts = Array.from({ length: MAX_LAYOUTS_PER_ACCOUNT + 1 }, (_, i) => ({ name: `L${i}`, layout: "1x1", cells: [null] }));
  const r = checkAccountLayouts({ layouts, defaultName: null });
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "layouts" && e.reason === "too_many_layouts"), true);
});

// ---------------------------------------------------------------- per-account scoping: the feared failure

check("accountLayouts on an account that has never saved anything is the honest empty slice, not undefined", () => {
  const file = emptyLayoutsFile();
  same(accountLayouts(file, "clerk"), { layouts: [], defaultName: null });
});

check("FEARED: accountLayouts for a username matching an inherited Object.prototype member is still the honest empty slice, never that member itself", () => {
  // validateName (contracts/access.ts) allows "constructor" as a username --
  // only "_"-leading names like "__proto__" are rejected -- so `file.accounts`
  // (a plain object) answers a bracket lookup for "constructor" with the
  // INHERITED Object constructor function (truthy), and `?? default` never
  // fires for it. Every one of Object.prototype's own function-valued
  // property names is exercised, not just "constructor".
  const file = emptyLayoutsFile();
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
    const got = accountLayouts(file, name);
    same(got, { layouts: [], defaultName: null }, `accountLayouts(file, ${JSON.stringify(name)})`);
    eq(typeof got.layouts, "object", `${name}: .layouts must be readable, never undefined off an inherited function`);
  }
});

check("REQUIRED: withAccountLayouts touches ONLY the named account — every other account's slice survives byte-for-byte", () => {
  let file = emptyLayoutsFile();
  const techLayouts = { layouts: [{ name: "Tech's own", layout: "2x2", cells: cells4("cam-1", null, null, null) }], defaultName: "Tech's own" };
  const clerkLayouts = { layouts: [{ name: "Clerk's own", layout: "1x1", cells: [null] }], defaultName: null };
  file = withAccountLayouts(file, "tech", techLayouts);
  file = withAccountLayouts(file, "clerk", clerkLayouts);

  same(accountLayouts(file, "tech"), techLayouts);
  same(accountLayouts(file, "clerk"), clerkLayouts);

  // Rewriting tech's own slice must not disturb clerk's at all.
  const techV2 = { layouts: [], defaultName: null };
  file = withAccountLayouts(file, "tech", techV2);
  same(accountLayouts(file, "tech"), techV2, "tech's own rewrite took");
  same(accountLayouts(file, "clerk"), clerkLayouts, "REQUIRED: clerk's slice is untouched by a write scoped to tech");

  // An account that never appears in the file at all is still the honest
  // empty slice, never leaking whatever the LAST account's data happened to be.
  same(accountLayouts(file, "installer2"), { layouts: [], defaultName: null });
});

check("setDefaultLayout only accepts a name this account actually has", () => {
  const account = { layouts: [{ name: "Front", layout: "2x2", cells: cells4() }], defaultName: null };
  const ok = setDefaultLayout(account, "Front");
  eq(ok.ok, true);
  eq(ok.account.defaultName, "Front");

  const bad = setDefaultLayout(account, "Back Lot");
  eq(bad.ok, false);
  eq(bad.reason, "no_such_layout");
});

check("defaultLayoutFor resolves the named default, or null when unset or stale", () => {
  const front = { name: "Front", layout: "2x2", cells: cells4() };
  eq(defaultLayoutFor({ layouts: [front], defaultName: null }), null);
  same(defaultLayoutFor({ layouts: [front], defaultName: "Front" }), front);
  eq(defaultLayoutFor({ layouts: [front], defaultName: "Gone" }), null, "a defaultName pointing at nothing answers null rather than throwing");
});

// ---------------------------------------------------------------- resolving cells against the camera list

check('REQUIRED: a camera id no longer configured resolves to "camera removed", never a silent blank', () => {
  const cells = ["cam-1", null, "cam-removed", "cam-2"];
  const resolved = resolveLayoutCells(cells, new Set(["cam-1", "cam-2"]));
  same(resolved, [
    { kind: "camera", index: 0, cameraId: "cam-1" },
    { kind: "empty", index: 1 },
    { kind: "removed", index: 2, cameraId: "cam-removed" },
    { kind: "camera", index: 3, cameraId: "cam-2" },
  ]);
});

check("resolveLayoutCells accepts a plain array of camera ids too, not only a Set", () => {
  const resolved = resolveLayoutCells(["cam-1", "cam-gone"], ["cam-1"]);
  eq(resolved[0].kind, "camera");
  eq(resolved[1].kind, "removed");
});

check("an entirely empty layout resolves to all-empty cells", () => {
  const resolved = resolveLayoutCells([null, null, null, null], new Set());
  eq(resolved.every((c) => c.kind === "empty"), true);
});

// ---------------------------------------------------------------- display layout assignments: no name, no default, its own door

check("a display layout validates the same shape rules as a named layout, minus name and default", () => {
  const r = checkDisplayLayout({ layout: "3x3", cells: Array.from({ length: 9 }, () => null) });
  eq(r.ok, true);
  same(r.layout, { layout: "3x3", cells: Array.from({ length: 9 }, () => null) });
  eq(Object.prototype.hasOwnProperty.call(r.layout, "name"), false, "a display's own layout carries no name at all");
});

check("a display layout with the wrong cell count for its shape is refused", () => {
  const r = checkDisplayLayout({ layout: "2x2", cells: [null, null] });
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "cells" && e.reason === "bad_cell_count"), true);
});

check("displayLayout on an unassigned display answers null, never a guessed shape", () => {
  const file = emptyDisplayLayoutsFile();
  eq(displayLayout(file, "wall-1"), null);
});

check("FEARED: displayLayout for a displayId matching an inherited Object.prototype member is still null, never that member itself", () => {
  // Same prototype-chain trap as accountLayouts's own regression test above,
  // for `file.displays`. validateName allows "constructor" as a displayId.
  const file = emptyDisplayLayoutsFile();
  for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
    eq(displayLayout(file, id), null, `displayLayout(file, ${JSON.stringify(id)})`);
  }
});

check("REQUIRED: withDisplayLayout touches only the named display — every other display's assignment survives untouched", () => {
  let file = emptyDisplayLayoutsFile();
  const wall1 = { layout: "2x2", cells: cells4("cam-1", null, null, null) };
  const wall2 = { layout: "1x1", cells: [null] };
  file = withDisplayLayout(file, "wall-1", wall1);
  file = withDisplayLayout(file, "wall-2", wall2);

  same(displayLayout(file, "wall-1"), wall1);
  same(displayLayout(file, "wall-2"), wall2);

  const wall1V2 = { layout: "3x3", cells: Array.from({ length: 9 }, () => null) };
  file = withDisplayLayout(file, "wall-1", wall1V2);
  same(displayLayout(file, "wall-1"), wall1V2);
  same(displayLayout(file, "wall-2"), wall2, "REQUIRED: wall-2's assignment is untouched by a write scoped to wall-1");
});

report("saved layouts");
