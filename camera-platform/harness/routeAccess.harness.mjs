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

check("a wall display watches live and reaches nothing recorded", () => {
  for (const [m, p] of [["GET", "/"], ["GET", "/cameras"], ["GET", "/devices"], ["GET", "/live/cam-1"], ["GET", "/ui/wall-client.js"]]) {
    eq(d(display, m, p).kind, "allow", `${m} ${p}`);
  }
  for (const [m, p] of [["GET", "/review"], ["GET", "/timeline"], ["GET", "/playback"], ["GET", "/segments/cam-1.1"],
    ["GET", "/export"], ["GET", "/export/plan"], ["GET", "/accounts"]]) {
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

report("route access");
