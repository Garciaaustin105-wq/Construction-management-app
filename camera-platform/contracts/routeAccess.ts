/**
 * Which request needs which permission, decided before any route runs.
 *
 * Default deny. A route that is not in this table is refused for everyone,
 * installer included: the failure this exists to prevent is a route added to
 * the server next month that nobody remembered to protect, answering the
 * whole LAN because the check lived inside each handler and this one forgot.
 *
 * A signed-out request for a route that does not exist gets the same 401 as
 * one for a route that does, so the refusal cannot be used to map the API.
 *
 * Pure: no I/O, no clock. The principal comes from agent/auth.mjs.
 */
import { authorise, type Permission, type Principal } from "./access.js";

export type RouteRule =
  /** Reachable signed out: the login page, its script, the auth routes. */
  | { kind: "public" }
  /** An HTML page. Signed out, the browser is sent to the login page. */
  | { kind: "page"; permission: Permission }
  /** JSON, a file or a stream. Signed out is a 401, never a redirect. */
  | { kind: "api"; permission: Permission };

/** Exact paths. A map, not prefix matching: "/accounts-backup" is not "/accounts". */
const GET_EXACT: Readonly<Record<string, RouteRule>> = Object.freeze({
  "/login": { kind: "public" },
  "/ui/login-client.js": { kind: "public" },
  "/auth/state": { kind: "public" },

  "/": { kind: "page", permission: "live.view" },
  "/review": { kind: "page", permission: "playback.view" },
  // The teach list (TEACH-LIST-SPEC.md piece 4): moments to label, from the
  // same footage /review and /clip-library already reach.
  "/teach": { kind: "page", permission: "playback.view" },
  "/system": { kind: "page", permission: "live.view" },
  "/accounts-page": { kind: "page", permission: "account.manage" },
  "/cameras-page": { kind: "page", permission: "camera.manage" },
  "/recording-page": { kind: "page", permission: "storage.manage" },
  "/network-page": { kind: "page", permission: "network.view" },
  // The activity page (ACTIVITY-PAGE-SPEC.md): sightings per camera by hour
  // and day. Same reach as /events and /known-objects -- events.view, which
  // a display never carries (contracts/access.ts), matching the spec's own
  // words ("A display never sees it").
  "/activity-page": { kind: "page", permission: "events.view" },

  // Page scripts carry no data and are already public source; they still sit
  // behind a sign-in so an unauthenticated scan learns nothing about the box.
  "/ui/live-client.js": { kind: "api", permission: "live.view" },
  "/ui/review-client.js": { kind: "api", permission: "playback.view" },
  "/ui/teach-client.js": { kind: "api", permission: "playback.view" },
  "/ui/alert-banner.js": { kind: "api", permission: "live.view" },
  "/ui/system-client.js": { kind: "api", permission: "live.view" },
  // The History section's chart builder (agent/ui/health-charts.mjs), served
  // at its real ".mjs" filename rather than the ".js" convention above --
  // see system-client.mjs's own import comment. Same reach as the System
  // page itself: it carries no data of its own, only chart-drawing code.
  "/ui/health-charts.mjs": { kind: "api", permission: "live.view" },
  // The Activity page's own client and chart builder -- same reach as the
  // page itself (events.view), not live.view like the scripts above: unlike
  // health-charts.mjs (chart-drawing code only), activity-charts.mjs's
  // module is loaded only from a page already gated on events.view, and
  // keeping the same permission here means a store account that cannot see
  // the page cannot fetch its script either.
  "/ui/activity-client.js": { kind: "api", permission: "events.view" },
  "/ui/activity-charts.mjs": { kind: "api", permission: "events.view" },
  "/ui/wall-client.js": { kind: "api", permission: "live.view" },
  "/ui/grid-layout.js": { kind: "api", permission: "live.view" },
  "/ui/playback.js": { kind: "api", permission: "playback.view" },
  "/ui/accounts-client.js": { kind: "api", permission: "account.manage" },
  "/ui/cameras-client.js": { kind: "api", permission: "camera.manage" },
  "/ui/recording-client.js": { kind: "api", permission: "storage.manage" },
  "/ui/network-client.js": { kind: "api", permission: "network.view" },
  // Every signed-in page loads it, a wall display included (it draws nothing there).
  "/ui/session.js": { kind: "api", permission: "live.view" },

  "/health": { kind: "api", permission: "live.view" },
  // The System page's History graphs (HEALTH-HISTORY-SPEC.md): the same page,
  // the same reach as /health itself -- this is "how it has been" for exactly
  // what /health already reports as "now".
  "/health/history": { kind: "api", permission: "live.view" },
  "/alerts": { kind: "api", permission: "live.view" },
  "/cameras": { kind: "api", permission: "live.view" },
  "/devices": { kind: "api", permission: "live.view" },
  "/timeline": { kind: "api", permission: "playback.view" },
  "/playback": { kind: "api", permission: "playback.view" },
  "/export/plan": { kind: "api", permission: "export.create" },
  "/export": { kind: "api", permission: "export.create" },
  "/accounts": { kind: "api", permission: "account.manage" },
  "/displays": { kind: "api", permission: "account.manage" },
  "/audit": { kind: "api", permission: "audit.view" },
  // Camera addresses and the login user name: the installer's, not the store's.
  "/camera-settings": { kind: "api", permission: "camera.manage" },
  // The age limit deletes footage.
  "/recording-settings": { kind: "api", permission: "storage.manage" },
  // The AI answer key: what someone watching the footage says is in it.
  "/clip-library": { kind: "api", permission: "playback.view" },
  // Candidate moments to label for the answer key (TEACH-LIST-SPEC.md), and
  // the still that illustrates each one: both are about footage, the same
  // reach as /clip-library and /playback, not a new permission of their own.
  "/teach-moments": { kind: "api", permission: "playback.view" },
  "/still": { kind: "api", permission: "playback.view" },
  // What the detector thinks it saw. Not playback.view: see access.ts.
  "/events": { kind: "api", permission: "events.view" },
  // Sightings per camera by hour and day (ACTIVITY-PAGE-SPEC.md) -- the same
  // detector content /events lists one row at a time, bucketed instead.
  "/activity": { kind: "api", permission: "events.view" },
  // A crop of the frame at an event's most confident moment — the same reach
  // as /events, because a crop IS an event's content, not recorded footage.
  "/event-crop": { kind: "api", permission: "events.view" },
  // The camera's known objects: recurring still false detections that are
  // hidden from /events. What they are is event content, so the same reach.
  "/known-objects": { kind: "api", permission: "events.view" },
  // The Network page's own JSON (NETWORK-PAGE-SPEC.md): interfaces, connection
  // checks, cameras' IP/MAC/maker/model and every other device this box has
  // seen without scanning. Installer only.
  "/network": { kind: "api", permission: "network.view" },
});

const POST_EXACT: Readonly<Record<string, RouteRule>> = Object.freeze({
  "/auth/activate": { kind: "public" },
  "/auth/login": { kind: "public" },
  "/auth/logout": { kind: "public" },
  "/auth/display": { kind: "public" },
  // Any signed-in person may change their own password; auth.mjs refuses a display.
  "/auth/password": { kind: "api", permission: "live.view" },
  "/accounts": { kind: "api", permission: "account.manage" },
  "/displays": { kind: "api", permission: "account.manage" },
  "/cameras": { kind: "api", permission: "camera.manage" },
  "/camera-login": { kind: "api", permission: "camera.manage" },
  "/recording-settings": { kind: "api", permission: "storage.manage" },
  // Saving a test clip keeps footage past retention: the same reach as an export.
  "/clip-library": { kind: "api", permission: "export.create" },
  // "It belongs there" / "It shouldn't be there": a label on a known object,
  // asked of whoever watches the events. It keeps no footage and changes no
  // setting, so the same reach as seeing the object.
  "/known-objects/answer": { kind: "api", permission: "events.view" },
  // "Look for cameras" (NETWORK-PAGE-SPEC.md): runs WS-Discovery and SADP on
  // the camera card. Same reach as /network; rate-limited separately in
  // agent/api-server.mjs, not by this policy table.
  "/network/discover": { kind: "api", permission: "network.view" },
});

/**
 * Paths with one trailing id segment. The id must be a single non-empty
 * segment: "/segments/" and "/segments/a/b" match nothing.
 */
const PREFIXED: ReadonlyArray<{ method: string; prefix: string; suffix: string; rule: RouteRule }> = Object.freeze([
  { method: "GET", prefix: "/segments/", suffix: "", rule: { kind: "api", permission: "playback.view" } },
  { method: "GET", prefix: "/live/", suffix: "", rule: { kind: "api", permission: "live.view" } },
  { method: "DELETE", prefix: "/accounts/", suffix: "", rule: { kind: "api", permission: "account.manage" } },
  { method: "POST", prefix: "/accounts/", suffix: "/password", rule: { kind: "api", permission: "account.manage" } },
  { method: "DELETE", prefix: "/displays/", suffix: "", rule: { kind: "api", permission: "account.manage" } },
  { method: "POST", prefix: "/cameras/", suffix: "", rule: { kind: "api", permission: "camera.manage" } },
  { method: "DELETE", prefix: "/cameras/", suffix: "", rule: { kind: "api", permission: "camera.manage" } },
]);

/** The rule for a request, or null when the server has no such route. */
export function ruleFor(method: string, pathname: string): RouteRule | null {
  const table = method === "GET" ? GET_EXACT : method === "POST" ? POST_EXACT : null;
  if (table !== null && Object.hasOwn(table, pathname)) return table[pathname] ?? null;
  for (const p of PREFIXED) {
    if (p.method !== method) continue;
    if (!pathname.startsWith(p.prefix) || !pathname.endsWith(p.suffix)) continue;
    const id = pathname.slice(p.prefix.length, pathname.length - p.suffix.length);
    if (id === "" || id.includes("/")) continue;
    return p.rule;
  }
  return null;
}

export type RouteDecision =
  | { kind: "allow" }
  /** A signed-out browser asking for a page: send it to sign in. */
  | { kind: "redirect"; location: string }
  | { kind: "refuse"; status: 401 | 403 | 404; code: string; message: string };

const UNAUTHENTICATED = { kind: "refuse", status: 401, code: "unauthenticated", message: "sign in first" } as const;

export function decideRoute(principal: Principal, method: string, pathname: string): RouteDecision {
  const rule = ruleFor(method, pathname);
  if (rule === null) {
    if (principal.kind === "anonymous") return UNAUTHENTICATED;
    return { kind: "refuse", status: 404, code: "no_such_route", message: "No such route" };
  }
  if (rule.kind === "public") return { kind: "allow" };
  const verdict = authorise(principal, rule.permission);
  if (verdict.kind === "allow") return { kind: "allow" };
  if (verdict.kind === "unauthenticated") {
    // Only ever a path from the table above, so the redirect cannot be
    // pointed at another site.
    if (rule.kind === "page") return { kind: "redirect", location: "/login?next=" + encodeURIComponent(pathname) };
    return UNAUTHENTICATED;
  }
  return {
    kind: "refuse",
    status: 403,
    code: "forbidden",
    message: "this account cannot do that (needs " + verdict.missing + ")",
  };
}

/**
 * Where to go after signing in. Only a page from the table: anything else,
 * including "//evil.example" and "/login" itself, goes home.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || !Object.hasOwn(GET_EXACT, next)) return "/";
  const rule = GET_EXACT[next];
  return rule !== undefined && rule.kind === "page" ? next : "/";
}
