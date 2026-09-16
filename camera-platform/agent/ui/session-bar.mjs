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

const signInAgain = () =>
  location.replace("/login?next=" + encodeURIComponent(location.pathname));

// Wrap fetch rather than touching each page's client: every request the
// page makes goes through window.fetch at call time, so one wrapper covers
// the polls, the timeline and the export plan alike.
const realFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await realFetch(...args);
  if (res.status === 401) signInAgain();
  return res;
};

function bar(principal) {
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

  if (principal.role === "installer" && location.pathname !== "/accounts-page") {
    const link = document.createElement("a");
    link.href = "/accounts-page";
    link.textContent = "Accounts";
    link.style.cssText = "color:#8ab4f8";
    el.append(link);
  }

  const out = document.createElement("button");
  out.type = "button";
  out.textContent = "Sign out";
  out.style.cssText =
    "font:inherit;padding:3px 10px;border:0;border-radius:12px;background:#2c2f36;color:#e8eaed;cursor:pointer";
  out.addEventListener("click", async () => {
    out.disabled = true;
    try {
      await realFetch("/auth/logout", {
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
// this only spares a wall display or a store login the dead end.
const PAGE_NEEDS = { "/review": "playback.view", "/system": "live.view", "/accounts-page": "account.manage" };

function hideRefusedLinks(permissions) {
  for (const a of document.querySelectorAll("a[href]")) {
    const need = PAGE_NEEDS[new URL(a.href, location.href).pathname];
    if (need !== undefined && !permissions.includes(need)) a.hidden = true;
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

try {
  const res = await realFetch("/auth/state", { credentials: "same-origin" });
  const state = await res.json();
  if (Array.isArray(state?.permissions)) hideRefusedLinks(state.permissions);
  if (state?.principal?.kind === "display") tvMode();
  if (state?.principal?.kind === "user") bar(state.principal);
  else if (state?.principal?.kind === "anonymous") signInAgain();
} catch {
  // The recorder is unreachable; the page's own error handling says so.
}
