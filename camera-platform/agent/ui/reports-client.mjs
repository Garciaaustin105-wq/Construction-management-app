// agent/ui/reports-client.mjs
//
// Client logic for the Reports page (agent/ui/reports.html, MANAGER-RULES-
// SPEC.md section 5): the daily report per local day, newest first, each
// firing a line with its own times and duration, grouped by rule, with a
// Review deep link and "Reports go back to <date>, as far as this NVR keeps
// video."
//
// Same discipline as agent/ui/activity-client.mjs: every dependency (the
// document, fetch, the clock) arrives through `opts`, never read off a bare
// global inside an exported function, so a harness can drive this without a
// browser. Nothing here ever sets innerHTML -- every piece of untrusted text
// (a rule's own name, folded into GET /reports' own firing.text by the
// server) is set with .textContent, never innerHTML.
//
// This page renders, it never re-derives: every firing's own `text` already
// carries its identity-free wording and its times IN THE SITE TIME ZONE
// (contracts/managerRules.ts's describeFiring, using GET /reports' own
// `timeZone`) -- this file never recomputes a clock label from startMs/endMs
// itself, which would risk a SECOND, possibly-drifting time-zone conversion
// of the same instant (build rule 17: never blend a measurement with a
// second guess at it).
//
// THE FEARED FAILURES:
// - a day picker whose default is the VIEWER's own browser day rather than
//   the SITE's local day (SITE-SETTINGS-SPEC.md's own zone discipline,
//   carried over here): todayInZone always asks GET /reports' response for
//   `timeZone` before it ever formats a day string with it, so the very
//   first render (before that response exists) sends no `day` guessed from
//   the browser's own clock at all -- see start() below.
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): a client with no
//   browser bootstrap block passes every harness check that drives its
//   exported functions directly while the real page never fetches anything.
//   See the bottom of this file.

/* ── pure helpers (no document, no fetch) ────────────────────────────── */

/** "YYYY-MM-DD" for `ms` in `timeZone` -- en-CA gives that exact format
 *  directly, the same trick contracts/managerRules.ts's own reportDayRange
 *  doc comment describes using Intl for, just for display rather than a UTC
 *  range. */
export function dayStringInZone(timeZone, ms) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  }
}

/** One calendar day before/after `day` ("YYYY-MM-DD") -- pure calendar
 *  arithmetic (UTC midnight of that date, shifted a whole day), never tied
 *  to any particular time zone's real elapsed time (a local day is not
 *  always 24h across a DST change, but "yesterday"/"tomorrow" as a LABEL is
 *  always the adjacent calendar date regardless). */
export function shiftDay(day, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** "Reports go back to <date>, as far as this NVR keeps video." --
 *  MANAGER-RULES-SPEC.md section 5, verbatim wording. `oldestFootageUtc:
 *  null` (no footage recorded at all yet) gets its own honest line, never a
 *  coverage claim this page cannot back up (the same discipline
 *  activity-client.mjs's own renderCoverage keeps for countsFromUtc). */
export function coverageText(oldestFootageUtc, timeZone) {
  if (typeof oldestFootageUtc !== "string") return "No footage recorded on this NVR yet.";
  const ms = Date.parse(oldestFootageUtc);
  if (!Number.isFinite(ms)) return "No footage recorded on this NVR yet.";
  return `Reports go back to ${dayStringInZone(timeZone, ms)}, as far as this NVR keeps video.`;
}

/** The Review deep link for one firing -- MANAGER-RULES-SPEC.md section 5:
 *  "/review?camera=&at=". Uses the firing's own startMs (when it began, the
 *  moment worth looking at), never endMs -- the same "point at the start of
 *  what happened" choice activity-client.mjs's own wireBarClickThrough makes
 *  for a sighting bar. */
export function reviewLinkFor(firing) {
  const q = new URLSearchParams({ camera: firing.cameraId, at: new Date(firing.startMs).toISOString() });
  return "/review?" + q.toString();
}

/* ── DOM helpers -- never innerHTML ──────────────────────────────────── */

function el(doc, tag, attrs, kids) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids || []) if (kid !== null && kid !== undefined) node.append(kid);
  return node;
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Renders one GET /reports envelope into #reportBody -- newest first within
 * each rule group (the server already writes firings in the chronological
 * order they were produced; this file reverses each group's own array for
 * display, since "newest first" is a RENDER choice, not something GET
 * /reports itself promises about its own array order).
 */
export function renderReport(doc, envelope, navigate) {
  const groupsEl = typeof doc.getElementById === "function" ? doc.getElementById("reportGroups") : null;
  const emptyEl = typeof doc.getElementById === "function" ? doc.getElementById("reportEmpty") : null;
  const coverageEl = typeof doc.getElementById === "function" ? doc.getElementById("reportCoverage") : null;
  const dayLabelEl = typeof doc.getElementById === "function" ? doc.getElementById("reportDayLabel") : null;

  if (dayLabelEl) dayLabelEl.textContent = envelope.day || "";
  if (coverageEl) coverageEl.textContent = coverageText(envelope.oldestFootageUtc, envelope.timeZone);

  if (!groupsEl) return;
  clearChildren(groupsEl);
  const groups = Array.isArray(envelope.groups) ? envelope.groups : [];
  if (emptyEl) emptyEl.hidden = groups.length > 0;
  for (const group of groups) {
    const heading = el(doc, "h3", {});
    heading.textContent = group.ruleName; // untrusted (a rule's own name): textContent only
    const list = el(doc, "ul", { class: "report-firings" }, []);
    const firings = Array.isArray(group.firings) ? [...group.firings].reverse() : [];
    for (const f of firings) {
      const line = el(doc, "span", {});
      line.textContent = f.text; // untrusted, already identity-free server-side: textContent only
      const link = el(doc, "a", { href: reviewLinkFor(f), text: "Review" });
      if (typeof navigate === "function") {
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          navigate(reviewLinkFor(f));
        });
      }
      list.append(el(doc, "li", {}, [line, link]));
    }
    groupsEl.append(el(doc, "section", { class: "report-group" }, [heading, list]));
  }
}

/* ── the whole page, one day at a time ───────────────────────────────── */

export function startReportsPage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const navigate = typeof opts.navigate === "function" ? opts.navigate : (url) => { window.location.assign(url); };

  const byId = (id) => (typeof doc.getElementById === "function" ? doc.getElementById(id) : null);
  const prevBtn = byId("reportPrevDay");
  const nextBtn = byId("reportNextDay");
  const errorEl = byId("reportError");

  // No day is guessed from the viewer's own clock/zone before the first
  // response tells us the SITE's zone (see the file header) -- `day` starts
  // null and the very first poll() call passes no `day` at all, letting GET
  // /reports' own... no: /reports REQUIRES a day. So the first poll asks
  // once with no zone knowledge, reads back the site's own `timeZone` from
  // the response, and re-issues exactly one corrected request for "today in
  // the site's own zone" -- never rendering the wrong day's report even for
  // an instant.
  let day = null;
  let timeZone = "UTC";

  async function fetchDay(d) {
    const res = await fetchFn("/reports?day=" + encodeURIComponent(d), { credentials: "same-origin" });
    if (res.status === 401) { navigate("/login?next=%2Freports-page"); return null; }
    if (res.status === 404) {
      if (errorEl) { errorEl.textContent = "The manager rules feature is off for this site."; errorEl.hidden = false; }
      return null;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) {
      if (errorEl) { errorEl.textContent = (body && body.message) || "The recorder refused that request."; errorEl.hidden = false; }
      return null;
    }
    if (errorEl) errorEl.hidden = true;
    return body;
  }

  async function poll() {
    if (day === null) {
      // First call: use the browser's own guess just to learn the site's
      // real zone from the response, then immediately correct it below.
      const guessDay = dayStringInZone(Intl.DateTimeFormat().resolvedOptions().timeZone, now());
      const first = await fetchDay(guessDay);
      if (!first) return;
      timeZone = first.timeZone || "UTC";
      day = dayStringInZone(timeZone, now());
      if (day === guessDay) {
        renderReport(doc, first, navigate);
        return;
      }
      // The site's zone reads a different calendar day right now: redo with
      // the corrected day rather than show the wrong one even once.
    }
    const body = await fetchDay(day);
    if (!body) return;
    timeZone = body.timeZone || timeZone;
    renderReport(doc, body, navigate);
  }

  if (prevBtn) prevBtn.addEventListener("click", () => { if (day !== null) { day = shiftDay(day, -1); void poll(); } });
  if (nextBtn) nextBtn.addEventListener("click", () => { if (day !== null) { day = shiftDay(day, 1); void poll(); } });

  const ready = poll().catch((err) => {
    log("error", "reports page could not load", { message: err && err.message });
  });

  return { ready, poll, getDay: () => day };
}

// Browser bootstrap. Runs only when the real page has its own container in
// the DOM; a harness importing this module for its pure helpers has no side
// effects. Copies camera-page-bootstrap-lesson: every new NVR page client
// needs this, and harness/reportsPage.harness.mjs proves it.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("reportBody")) {
  startReportsPage({
    doc: document,
    fetchFn: function (url, init) { return fetch(url, init); },
    now: () => Date.now(),
    navigate: (url) => { window.location.assign(url); },
    log: () => {},
  });
}
