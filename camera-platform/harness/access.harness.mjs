/**
 * Who may do what on an appliance: the installer and store accounts, a wall
 * display, and nobody.
 *
 * The failures these checks exist to prevent (build rule 19):
 *
 *  - The store account reaching anything that destroys footage or reconfigures
 *    the box. Retention above all: it reads like a preference and behaves like
 *    a delete button.
 *  - A TV on the wall holding more than "watch live". It runs unattended and
 *    whoever is alone in the room with it has whatever it has.
 *  - Failing open on data that did not come from this code: a role, a
 *    permission or a principal kind read back from a tampered session or a
 *    newer config must be refused, never guessed generously.
 *  - The last installer account being removable, including when the installer
 *    count is unknown. That box can only be recovered with a site visit.
 *  - A caller editing the policy by accident, by sorting or pushing onto an
 *    array it was handed.
 *  - A 401 where a 403 belongs: a store account opening a settings page must
 *    be told it is not allowed, not bounced to a login it already passed.
 *  - A short password passing the length rule because it is counted in UTF-16
 *    units: six emoji are six characters, not twelve.
 */
import {
  ALL_PERMISSIONS, permissionsFor, can, authorise,
  validatePassword, MIN_PASSWORD_LENGTH, needsActivation, canRemoveAccount,
} from "../dist/access.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("access");

const installer = { kind: "user", username: "tech", role: "installer" };
const store = { kind: "user", username: "frontdesk", role: "store" };
const display = { kind: "display", displayId: "backroom-tv" };
const nobody = { kind: "anonymous" };

const DESTRUCTIVE = ["camera.manage", "storage.manage", "system.manage", "account.manage"];

check("the installer can do everything there is", () => {
  for (const p of ALL_PERMISSIONS) eq(can(installer, p), true, p);
  eq(ALL_PERMISSIONS.length, 11, "eleven permissions; a new one needs a decision below");
});

check("the store has exactly its daily job: watch, review, export, hold, layout", () => {
  same(ALL_PERMISSIONS.filter((p) => can(store, p)),
    ["live.view", "playback.view", "export.create", "segment.hold", "layout.edit", "events.view"], "store permissions");
});

check("the store cannot reach anything that destroys footage or reconfigures the box", () => {
  for (const p of DESTRUCTIVE) eq(can(store, p), false, p);
  eq(can(store, "audit.view"), false, "audit.view");
});

check("a wall display can watch and look back, and take nothing away", () => {
  // The line is between looking and taking, not between live and recorded: a
  // manager at the wall may scrub back without signing in, but a clip leaving
  // the building has to be signed for, because the audit log needs a name and
  // a display is a device.
  same(ALL_PERMISSIONS.filter((p) => can(display, p)), ["live.view", "playback.view"], "display permissions");
  eq(can(display, "export.create"), false, "THE FEARED ONE: a token left on a TV cannot walk out with the footage");
  eq(can(display, "segment.hold"), false, "nor decide what retention may not evict");
  // The AI decision (access.ts): a wall is unattended, and a list of every
  // time a person walked past is not the picture already on the screen.
  eq(can(display, "events.view"), false, "THE FEARED ONE: an unattended TV does not list who walked past");
});

check("nobody signed in can do nothing at all", () => {
  for (const p of ALL_PERMISSIONS) eq(can(nobody, p), false, p);
});

check("401 for nobody, 403 naming the missing permission for the signed-in", () => {
  same(authorise(nobody, "live.view"), { kind: "unauthenticated" }, "anonymous");
  same(authorise(store, "storage.manage"), { kind: "forbidden", missing: "storage.manage" }, "store on retention");
  same(authorise(display, "export.create"), { kind: "forbidden", missing: "export.create" }, "display exporting");
  same(authorise(store, "export.create"), { kind: "allow" }, "store exporting");
  same(authorise(installer, "account.manage"), { kind: "allow" }, "installer");
});

check("a role, permission or principal this code never issued is refused", () => {
  // What a tampered session cookie or a newer config file can hand back.
  for (const role of ["admin", "Installer", "", "__proto__", "constructor", undefined, null]) {
    const who = { kind: "user", username: "x", role };
    for (const p of ALL_PERMISSIONS) eq(can(who, p), false, `role ${String(role)} / ${p}`);
    same(permissionsFor(role), [], `permissionsFor(${String(role)})`);
  }
  for (const p of ["constructor", "__proto__", "length", "*", "storage.*", ""]) {
    eq(can(installer, p), false, `installer / permission ${p}`);
  }
  for (const kind of ["admin", "installer", "", undefined]) {
    eq(can({ kind, role: "installer" }, "live.view"), false, `principal kind ${String(kind)}`);
  }
});

check("a caller cannot edit the policy through an array it was handed", () => {
  const mine = permissionsFor("store");
  mine.push("storage.manage");
  mine.sort();
  eq(can(store, "storage.manage"), false, "pushing onto permissionsFor's result");
  let threw = false;
  try {
    ALL_PERMISSIONS.push("anything");
  } catch {
    threw = true;
  }
  eq(threw, true, "ALL_PERMISSIONS is frozen");
  eq(ALL_PERMISSIONS.length, 11, "and still eleven long");
});

check("there is no way in until an installer exists, and unknown counts as none", () => {
  eq(needsActivation(0), true, "0");
  eq(needsActivation(1), false, "1");
  eq(needsActivation(3), false, "3");
  for (const n of [NaN, Infinity, -1, 0.5, undefined, null, "1"]) {
    eq(needsActivation(n), true, `count ${String(n)}`);
  }
});

check("the last installer cannot be removed, and neither can one when the count is unknown", () => {
  const tech = { username: "tech", role: "installer" };
  eq(canRemoveAccount(tech, 1).kind, "refused", "only installer");
  eq(canRemoveAccount(tech, 0).kind, "refused", "count 0 (already inconsistent)");
  eq(canRemoveAccount(tech, 2).kind, "ok", "one of two");
  for (const n of [NaN, Infinity, 1.5, undefined, null, "2"]) {
    eq(canRemoveAccount(tech, n).kind, "refused", `count ${String(n)}`);
  }
  eq(canRemoveAccount({ username: "frontdesk", role: "store" }, 1).kind, "ok", "store account, any count");
  eq(canRemoveAccount({ username: "frontdesk", role: "store" }, NaN).kind, "ok", "a store account never locks the box");
});

check("passwords: length is the rule, counted in characters a person types", () => {
  eq(MIN_PASSWORD_LENGTH, 12, "minimum");
  eq(validatePassword("correct horse battery").kind, "ok", "a passphrase");
  eq(validatePassword("abcdefghijk").kind, "rejected", "11 characters");
  eq(validatePassword("abcdefghijkl").kind, "ok", "12 characters");
  eq(validatePassword("\u{1F512}".repeat(6)).kind, "rejected", "six emoji are six characters");
  eq(validatePassword("\u{1F512}".repeat(12)).kind, "ok", "twelve emoji are twelve");
});

check("passwords: blanks, padding, non-strings and the username are refused", () => {
  for (const bad of [undefined, null, 123456789012, "", ["abcdefghijkl"]]) {
    eq(validatePassword(bad).kind, "rejected", `candidate ${JSON.stringify(bad)}`);
  }
  eq(validatePassword(" abcdefghijkl").kind, "rejected", "leading space");
  eq(validatePassword("abcdefghijkl ").kind, "rejected", "trailing space");
  eq(validatePassword("            ").kind, "rejected", "all spaces");
  eq(validatePassword("FrontDesk-Main", "frontdesk-main").kind, "rejected", "the username, any case");
  eq(validatePassword("abcdefghijkl", "").kind, "ok", "an empty username is not a match");
});

check("passwords: a username that is not a string does not crash the check", () => {
  // Accounts arrive as JSON. A numeric username must not turn a password
  // check into a 500.
  eq(validatePassword("abcdefghijkl", 42).kind, "ok", "numeric username");
  eq(validatePassword("abcdefghijkl", null).kind, "ok", "null username");
});

check("passwords: the first ones anyone tries are refused however they are padded out", () => {
  // Every entry on the list is under twelve characters, so the list only
  // matters for the long forms people actually type to get past a length rule.
  for (const bad of ["password1234", "Password1234", "admin1234567", "hikvision123", "123456789012", "changeme1234"]) {
    eq(validatePassword(bad).kind, "rejected", bad);
  }
});

report("access");
