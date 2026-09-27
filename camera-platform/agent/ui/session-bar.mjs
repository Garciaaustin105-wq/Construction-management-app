// agent/ui/session-bar.mjs — served as /ui/session.js
//
// One line on each signed-in page: who is signed in, and a way out. It also
// catches the moment a session ends underneath an open page (idle timeout, a
// password reset, the account removed): any 401 from this page's own requests
// sends the browser to sign in and back, instead of leaving a live wall or a
// review page quietly showing "request failed" forever.
//
// A wall display gets no bar. It has no password to sign back in with, and
// nobody standing at a TV should be offered a button that unpairs it.
//
// PAGE_NEEDS and hideRefusedLinks are exported so a harness can prove the
// hiding rule directly (e.g. harness/networkPage.harness.mjs) without a
// browser. Everything below that touches `window` or `document` for real --
// the fetch wrap, the bar, the auth/state fetch -- sits behind the guard at
// the bottom, so importing this module in Node for those two names alone
// does nothing but define them.

function signInAgain() {
  location.replace("/login?next=" + encodeURIComponent(location.pathname));
}

function bar(principal, fetchFn, features) {
  const el = document.createElement("div");
  el.id = "sessionBar";
  el.setAttribute("role", "navigation");
  el.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:1000;display:flex;gap:8px;align-items:center;" +
    "padding:4px 6px 4px 10px;background:#1b1d22e6;border:1px solid #2c2f36;border-radius:16px;" +
    "font:12px/1.4 system-ui,sans-serif;color:#9aa0a6;max-width:calc(100vw - 16px)";

  const who = document.createElement("span");
  who.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  who.textContent = `${principal.username} (${principal.role})`;
  el.append(who);

  // The Activity page (ACTIVITY-PAGE-SPEC.md): both roles carry events.view
  // (contracts/access.ts -- installer holds every permission, and it is one
  // of the store role's own daily ones), so this link is not restricted to
  // installer like Cameras/Recording/Accounts below -- it is one of "the
  // pages the store role uses", the spec's own words.
  // SITE-SETTINGS-SPEC.md: "a switched-off feature: its nav link is
  // hidden" -- checked here at build time (features.activity === false skips
  // the link outright) AND again below via hideFeatureLinks, for any link a
  // page's own static HTML wrote (this bar's own link never needs the
  // second pass, but a future page's <nav> might).
  const feats = (features && typeof features === "object") ? features : {};
  if (feats.activity !== false) {
    for (const [href, text] of [["/activity-page", "Activity"]]) {
      if (location.pathname === href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.textContent = text;
      link.style.cssText = "color:#8ab4f8";
      el.append(link);
    }
  }

  // Rules and Reports (MANAGER-RULES-SPEC.md section 5): "hidden unless the
  // permission AND the managerRules switch are there." The switch is checked
  // right here (feats.managerRules !== false), same shape as the Activity
  // link above; the PERMISSION half is never checked here at all -- every
  // signed-in user gets both links built, and hideRefusedLinks (called after
  // bar() returns, at the bottom of this file) removes whichever one this
  // account's own permissions do not cover. A store account keeps Reports
  // (events.view) and loses Rules (rules.manage); a manager keeps both but
  // never sees Cameras/Recording/Accounts below, which stay behind their own
  // installer-only block.
  if (feats.managerRules !== false) {
    for (const [href, text] of [["/rules-page", "Rules"], ["/reports-page", "Reports"]]) {
      if (location.pathname === href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.textContent = text;
      link.style.cssText = "color:#8ab4f8";
      el.append(link);
    }
  }

  if (principal.role === "installer") {
    for (const [href, text] of [["/cameras-page", "Cameras"], ["/recording-page", "Recording"], ["/accounts-page", "Accounts"]]) {
      if (location.pathname === href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.textContent = text;
      link.style.cssText = "color:#8ab4f8";
      el.append(link);
    }
  }

  const out = document.createElement("button");
  out.type = "button";
  out.textContent = "Sign out";
  out.style.cssText =
    "font:inherit;padding:3px 10px;border:0;border-radius:12px;background:#2c2f36;color:#e8eaed;cursor:pointer";
  out.addEventListener("click", async () => {
    out.disabled = true;
    try {
      await fetchFn("/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      });
    } finally {
      location.replace("/login");
    }
  });
  el.append(out);
  document.body.append(el);
}

// Links to pages this account may not open. The server refuses them anyway;
// this only spares a wall display or a store login the dead end. The
// Network page (NETWORK-PAGE-SPEC.md) is installer-only, like Cameras,
// Recording and Accounts -- a store account never sees the link.
export const PAGE_NEEDS = {
  "/review": "playback.view",
  "/system": "live.view",
  "/activity-page": "events.view",
  "/accounts-page": "account.manage",
  "/cameras-page": "camera.manage",
  "/recording-page": "storage.manage",
  "/network-page": "network.view",
  // MANAGER-RULES-SPEC.md section 5 -- same permissions as routeAccess.ts's
  // own GET_EXACT entries for these two pages.
  "/rules-page": "rules.manage",
  "/reports-page": "events.view",
};

/**
 * `doc` is any object with `querySelectorAll("a[href]")` -- the real
 * `document` in the browser, or a small fake one in a harness. The pathname
 * is read off the raw `href` attribute rather than the DOM's own resolved
 * `a.href` (which needs `location` to resolve against): every href this
 * page ever writes is already a root-relative path, so `new URL(href,
 * "http://x")` gives the identical pathname without depending on the page's
 * own origin at all -- one less thing a harness has to fake.
 */
export function hideRefusedLinks(doc, permissions) {
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = typeof a.getAttribute === "function" ? a.getAttribute("href") : a.href;
    let pathname;
    try {
      pathname = new URL(href, "http://x").pathname;
    } catch {
      continue;
    }
    const need = PAGE_NEEDS[pathname];
    if (need !== undefined && !permissions.includes(need)) a.hidden = true;
  }
}

// Links a switched-off site feature hides (SITE-SETTINGS-SPEC.md: "its nav
// link is hidden ... never 403, which would read as a permission problem").
// GET /site (every signed-in kind, a display included) is where the answer
// comes from -- not routeAccess.ts/PAGE_NEEDS above, which only ever answers
// "may this ROLE reach this page", never "is this feature on for this site".
export const FEATURE_LINKS = {
  "/activity-page": "activity",
  // MANAGER-RULES-SPEC.md section 4: "Off means the Rules and Reports nav
  // links are hidden" -- the switch half of "hidden unless the permission
  // AND the managerRules switch are there"; the permission half is
  // PAGE_NEEDS/hideRefusedLinks above.
  "/rules-page": "managerRules",
  "/reports-page": "managerRules",
};

/**
 * `features` is GET /site's own `features` map. A feature this map does not
 * mention at all reads as ON (the same "a blank is not a zero" rule the
 * server's own isFeatureEnabled keeps) -- only an explicit `false` hides a
 * link, so a page loaded before the site ever answered (features undefined)
 * hides nothing.
 */
export function hideFeatureLinks(doc, features) {
  const feats = (features && typeof features === "object") ? features : {};
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = typeof a.getAttribute === "function" ? a.getAttribute("href") : a.href;
    let pathname;
    try {
      pathname = new URL(href, "http://x").pathname;
    } catch {
      continue;
    }
    const key = FEATURE_LINKS[pathname];
    if (key !== undefined && feats[key] === false) a.hidden = true;
  }
}

// A wall display is a TV nobody touches: keep its screen on, and hide the
// pointer once it stops moving. Only for a display login -- a person's own
// screen keeps its normal sleep (and an OLED is not held on by a forgotten tab).
function tvMode() {
  let lock = null;
  const hold = async () => {
    if (document.visibilityState !== "visible" || lock !== null || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => { lock = null; });
    } catch {
      // Refused (battery saver, or not a secure context): the TV's own settings decide.
    }
  };
  hold();
  // The browser drops the lock whenever the tab is hidden; take it back on return.
  document.addEventListener("visibilitychange", hold);

  let idle;
  const wake = () => {
    document.documentElement.style.cursor = "";
    clearTimeout(idle);
    idle = setTimeout(() => { document.documentElement.style.cursor = "none"; }, 3000);
  };
  document.addEventListener("pointermove", wake);
  wake();
}

// Everything below touches `window`, `document` or the network for real, and
// runs only when this module is loaded as a browser <script> (as /ui/session.js
// always is). A harness importing this file for PAGE_NEEDS/hideRefusedLinks
// alone runs in Node, where `window` is undefined, so this block is skipped
// rather than throwing on a global that does not exist there.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  // Wrap fetch rather than touching each page's client: every request the
  // page makes goes through window.fetch at call time, so one wrapper covers
  // the polls, the timeline and the export plan alike.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.status === 401) signInAgain();
    return res;
  };

  try {
    // /site (SITE-SETTINGS-SPEC.md) reaches every signed-in kind, a display
    // included -- fetched alongside /auth/state so a switched-off feature's
    // link never shows even for the instant before this resolves. A failed
    // /site (unreachable recorder mid-request) is not fatal to the rest of
    // this bar: `features` just stays undefined, and hideFeatureLinks/bar
    // both read that as "hide nothing", never as "everything is off".
    const [authRes, siteRes] = await Promise.all([
      realFetch("/auth/state", { credentials: "same-origin" }),
      realFetch("/site", { credentials: "same-origin" }).catch(() => null),
    ]);
    const state = await authRes.json();
    const site = siteRes ? await siteRes.json().catch(() => null) : null;
    const features = site && typeof site === "object" ? site.features : undefined;
    if (Array.isArray(state?.permissions)) hideRefusedLinks(document, state.permissions);
    if (state?.principal?.kind === "display") tvMode();
    if (state?.principal?.kind === "user") bar(state.principal, realFetch, features);
    else if (state?.principal?.kind === "anonymous") signInAgain();
    if (features !== undefined) hideFeatureLinks(document, features);
  } catch {
    // The recorder is unreachable; the page's own error handling says so.
  }
}
