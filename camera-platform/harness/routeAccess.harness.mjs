/**
 * The route table: which request needs which permission, before any handler.
 *
 * The failures these checks exist to prevent (build rule 19):
 *
 *  - A route missing from the table answering anyway. Default deny: unknown is
 *    refused for everyone, the installer included.
 *  - A signed-out scan telling real routes from made-up ones by the status.
 *  - A near-miss path slipping through: "/accounts-backup", "/segments/",
 *    "/segments/a/b", a POST to a GET route, a lowercase method.
 *  - The store reaching account management or the audit log, and a wall
 *    display reaching recorded footage, exports or its own "password".
 *  - The post-login redirect being pointed off the box ("//evil.example").
 */
import { ruleFor, decideRoute, safeNext } from "../dist/routeAccess.js";
import { validateName } from "../dist/access.js";
import { check, eq, same, report } from "./_assert.mjs";

console.log("route access");

const installer = { kind: "user", username: "tech", role: "installer" };
const store = { kind: "user", username: "frontdesk", role: "store" };
const display = { kind: "display", displayId: "backroom-tv" };
const nobody = { kind: "anonymous" };
const d = (who, method, path) => decideRoute(who, method, path);

check("signed out, only the login page, its script and the auth routes answer", () => {
  for (const [m, p] of [["GET", "/login"], ["GET", "/ui/login-client.js"], ["GET", "/auth/state"],
    ["POST", "/auth/login"], ["POST", "/auth/activate"], ["POST", "/auth/logout"], ["POST", "/auth/display"]]) {
    eq(d(nobody, m, p).kind, "allow", `${m} ${p}`);
  }
  for (const [m, p] of [["GET", "/health"], ["GET", "/cameras"], ["GET", "/segments/cam-1.1"], ["GET", "/live/cam-1"],
    ["GET", "/export"], ["GET", "/accounts"], ["POST", "/accounts"], ["DELETE", "/accounts/tech"],
    ["GET", "/ui/wall-client.js"], ["POST", "/auth/password"], ["GET", "/audit"]]) {
    same(d(nobody, m, p), { kind: "refuse", status: 401, code: "unauthenticated", message: "sign in first" }, `${m} ${p}`);
  }
});

check("signed out, a page sends the browser to sign in and comes back to it", () => {
  same(d(nobody, "GET", "/"), { kind: "redirect", location: "/login?next=%2F" }, "/");
  same(d(nobody, "GET", "/review"), { kind: "redirect", location: "/login?next=%2Freview" }, "/review");
});

check("signed out, a made-up route looks exactly like a real one", () => {
  for (const p of ["/nope", "/accounts-backup", "/.env", "/segments/", "/segments/a/b", "/ui/"]) {
    same(d(nobody, "GET", p), d(nobody, "GET", "/health"), p);
  }
});

check("default deny: a route not in the table is refused even to the installer", () => {
  for (const [m, p] of [["GET", "/nope"], ["GET", "/accounts-backup"], ["GET", "/segments/"], ["GET", "/segments/a/b"],
    ["PUT", "/accounts"], ["POST", "/health"], ["get", "/health"], ["DELETE", "/accounts/"], ["POST", "/accounts/tech"],
    ["POST", "/accounts/a/b/password"], ["GET", "/__proto__"], ["GET", "/constructor"], ["POST", "/toString"]]) {
    eq(d(installer, m, p).kind, "refuse", `${m} ${p}`);
    eq(ruleFor(m, p), null, `no rule for ${m} ${p}`);
  }
});

check("the store has its daily job and nothing that manages the box", () => {
  for (const [m, p] of [["GET", "/"], ["GET", "/review"], ["GET", "/health"], ["GET", "/timeline"],
    ["GET", "/segments/cam-1.1"], ["GET", "/export"], ["GET", "/live/cam-1"], ["POST", "/auth/password"]]) {
    eq(d(store, m, p).kind, "allow", `${m} ${p}`);
  }
  for (const [m, p] of [["GET", "/accounts"], ["POST", "/accounts"], ["DELETE", "/accounts/tech"],
    ["POST", "/accounts/tech/password"], ["GET", "/displays"], ["POST", "/displays"], ["DELETE", "/displays/tv"],
    ["GET", "/audit"], ["GET", "/accounts-page"]]) {
    const r = d(store, m, p);
    eq(r.kind === "refuse" && r.status === 403, true, `${m} ${p}: ${JSON.stringify(r)}`);
  }
});

check("a wall display watches live and looks back, and takes nothing away", () => {
  // The line is between looking and taking. Someone standing at the wall may
  // scrub back without signing in; a clip leaving the building is signed for,
  // because the audit log needs a name and a display is a device.
  for (const [m, p] of [["GET", "/"], ["GET", "/cameras"], ["GET", "/devices"], ["GET", "/live/cam-1"],
    ["GET", "/ui/wall-client.js"], ["GET", "/review"], ["GET", "/timeline"], ["GET", "/playback"],
    ["GET", "/segments/cam-1.1"]]) {
    eq(d(display, m, p).kind, "allow", `${m} ${p}`);
  }
  // THE FEARED ONE: a token that lives on a TV forever, reachable by whoever is
  // in the room, must not be able to copy the footage out of the building.
  for (const [m, p] of [["GET", "/export"], ["GET", "/export/plan"], ["GET", "/accounts"]]) {
    eq(d(display, m, p).kind, "refuse", `${m} ${p}`);
  }
  same(d(display, "GET", "/export"), { kind: "refuse", status: 403, code: "forbidden",
    message: "this account cannot do that (needs export.create)" }, "names what is missing");
});

check("the installer reaches every route in the table", () => {
  for (const [m, p] of [["GET", "/accounts"], ["POST", "/accounts"], ["DELETE", "/accounts/frontdesk"],
    ["POST", "/accounts/frontdesk/password"], ["GET", "/displays"], ["POST", "/displays"], ["DELETE", "/displays/tv"],
    ["GET", "/audit"], ["GET", "/accounts-page"], ["GET", "/export"]]) {
    eq(d(installer, m, p).kind, "allow", `${m} ${p}`);
  }
});

const CAMERA_EDIT = [["GET", "/cameras-page"], ["GET", "/ui/cameras-client.js"], ["GET", "/camera-settings"],
  ["POST", "/cameras"], ["POST", "/cameras/cam-1"], ["DELETE", "/cameras/cam-1"], ["POST", "/camera-login"]];

check("FEARED: only the installer edits cameras or sees their addresses and login", () => {
  for (const [m, p] of CAMERA_EDIT) {
    eq(d(installer, m, p).kind, "allow", `installer ${m} ${p}`);
    const s = d(store, m, p);
    eq(s.kind === "refuse" && s.status === 403, true, `store ${m} ${p}: ${JSON.stringify(s)}`);
    eq(d(display, m, p).kind, "refuse", `display ${m} ${p}`);
    eq(d(nobody, m, p).kind === "allow", false, `signed out ${m} ${p}`);
  }
  for (const [m, p] of [["DELETE", "/cameras"], ["PUT", "/cameras/cam-1"], ["POST", "/cameras/"], ["POST", "/cameras/a/b"],
    ["DELETE", "/camera-login"], ["GET", "/cameras/cam-1"]]) {
    eq(ruleFor(m, p), null, `${m} ${p}`);
  }
  eq(d(store, "GET", "/cameras").kind, "allow", "the store still sees the camera list itself");
});

check("after sign-in, only a page on this box is a destination", () => {
  eq(safeNext("/review"), "/review", "a page");
  for (const bad of ["//evil.example", "https://evil.example", "/login", "/health", "/review?x=1", "", null, 7, "/__proto__"]) {
    eq(safeNext(bad), "/", `next ${JSON.stringify(bad)}`);
  }
});

check("names are lowercased, URL-safe and bounded", () => {
  same(validateName("Tech"), { kind: "ok", name: "tech" }, "lowercased");
  eq(validateName("front-desk_2.b").kind, "ok", "dots, dashes, underscores");
  eq(validateName("a".repeat(32)).kind, "ok", "32");
  for (const bad of ["", "a".repeat(33), "-lead", ".lead", "has space", "a/b", "..", "tëch", "a%2Fb", null, 42]) {
    eq(validateName(bad).kind, "rejected", JSON.stringify(bad));
  }
});

check("the detector's events: the store may read them, a wall display may not", () => {
  same(ruleFor("GET", "/events"), { kind: "api", permission: "events.view" }, "its own permission, not playback.view");
  eq(d(store, "GET", "/events").kind, "allow", "the person behind the counter, looking for this morning");
  eq(d(installer, "GET", "/events").kind, "allow", "and the installer");
  same(d(display, "GET", "/events"), { kind: "refuse", status: 403, code: "forbidden",
    message: "this account cannot do that (needs events.view)" },
    "THE FEARED ONE: a TV in a back room does not hand out a list of everyone who walked past");
  eq(d(nobody, "GET", "/events").status, 401, "signed out");
  eq(d(installer, "POST", "/events").status, 404, "GET only");
  eq(d(installer, "GET", "/events/").status, 404, "not a prefix");
});

check("event crops: the same reach as /events, because a crop IS an event's content", () => {
  same(ruleFor("GET", "/event-crop"), { kind: "api", permission: "events.view" }, "same permission as /events");
  eq(d(store, "GET", "/event-crop").kind, "allow", "the person behind the counter, checking what fired");
  eq(d(installer, "GET", "/event-crop").kind, "allow", "and the installer");
  same(d(display, "GET", "/event-crop"), { kind: "refuse", status: 403, code: "forbidden",
    message: "this account cannot do that (needs events.view)" },
    "THE FEARED ONE: a TV in a back room does not get the picture of who walked past either");
  eq(d(nobody, "GET", "/event-crop").status, 401, "signed out");
  eq(d(installer, "POST", "/event-crop").status, 404, "GET only");
  eq(d(installer, "GET", "/event-crop/").status, 404, "not a prefix — the id is a query param, not a path segment");
});

check("known objects: the same reach as /events, and a wall display may neither see nor answer them", () => {
  // Added with the routes (2026-09-23). Found in review: until this check the
  // only test of these two rules used a stand-in, so a typo or a looser
  // permission here would have passed a green suite.
  same(ruleFor("GET", "/known-objects"), { kind: "api", permission: "events.view" }, "what is hidden is event content");
  same(ruleFor("POST", "/known-objects/answer"), { kind: "api", permission: "events.view" }, "a label, from whoever watches the events");
  for (const [method, path] of [["GET", "/known-objects"], ["POST", "/known-objects/answer"]]) {
    eq(d(store, method, path).kind, "allow", `${method} ${path}: the store`);
    eq(d(installer, method, path).kind, "allow", `${method} ${path}: the installer`);
    same(d(display, method, path), { kind: "refuse", status: 403, code: "forbidden",
      message: "this account cannot do that (needs events.view)" }, `THE FEARED ONE: ${method} ${path}: a wall display`);
    eq(d(nobody, method, path).status, 401, `${method} ${path}: signed out`);
  }
  eq(d(installer, "POST", "/known-objects").status, 404, "the list is GET only");
  eq(d(installer, "GET", "/known-objects/answer").status, 404, "the answer is POST only");
});

check("the teach list: the same reach as /clip-library and /playback, because both are about footage, not a new permission", () => {
  same(ruleFor("GET", "/teach-moments"), { kind: "api", permission: "playback.view" }, "same permission as /clip-library and /playback");
  same(ruleFor("GET", "/still"), { kind: "api", permission: "playback.view" }, "same permission as /clip-library and /playback");
  for (const path of ["/teach-moments", "/still"]) {
    eq(d(store, "GET", path).kind, "allow", `${path}: the store watches this footage too`);
    eq(d(installer, "GET", path).kind, "allow", `${path}: and the installer`);
    eq(d(display, "GET", path).kind, "allow", `${path}: THE SAME LINE AS /playback -- a wall display may scrub back, so it may look at a candidate moment too`);
    eq(d(nobody, "GET", path).status, 401, `${path}: signed out`);
    eq(d(installer, "POST", path).status, 404, `${path}: GET only`);
    eq(d(installer, "GET", path + "/").status, 404, `${path}: not a prefix`);
  }
});

check("the teach page: the same reach as Review (playback.view), and a wall display may look but never save a label", () => {
  same(ruleFor("GET", "/teach"), { kind: "page", permission: "playback.view" }, "the page");
  same(ruleFor("GET", "/ui/teach-client.js"), { kind: "api", permission: "playback.view" }, "its script");
  for (const path of ["/teach", "/ui/teach-client.js"]) {
    eq(d(store, "GET", path).kind, "allow", `${path}: the store`);
    eq(d(installer, "GET", path).kind, "allow", `${path}: the installer`);
    // A display "watches live and looks back" (see the check above), so it
    // may open this like /review.
    eq(d(display, "GET", path).kind, "allow", `${path}: a wall display may look, as at /review`);
  }
  // THE FEARED ONE: a label keeps footage past retention, so saving one is
  // signed for; a device on a wall may not write the answer key.
  eq(d(display, "POST", "/clip-library").kind, "refuse", "a wall display cannot save a label");
  eq(d(nobody, "GET", "/teach").kind === "allow", false, "signed out: not let in");
});

report("route access");
