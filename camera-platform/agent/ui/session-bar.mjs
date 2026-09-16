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

try {
  const res = await realFetch("/auth/state", { credentials: "same-origin" });
  const state = await res.json();
  if (state?.principal?.kind === "user") bar(state.principal);
  else if (state?.principal?.kind === "anonymous") signInAgain();
} catch {
  // The recorder is unreachable; the page's own error handling says so.
}
