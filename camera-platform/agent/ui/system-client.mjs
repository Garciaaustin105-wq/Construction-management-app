// agent/ui/system-client.mjs
//
// Client logic for the System page (agent/ui/system.html).
//
// The page answers the one question an installer standing in front of
// the NVR has: is this thing actually recording? It polls GET /health
// every few seconds and draws the answer. Everything testable is
// exported so a harness can drive it without a browser; the document,
// the fetch function and the timers always arrive via opts and are
// never taken from the global scope inside the exported functions.
//
// House rule: null is not zero and must never look like zero. A missing
// measurement renders as words -- "not measured", "never", "unknown" --
// never as 0, an empty cell or a bare dash.

const NOT_MEASURED = "not measured";

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function byId(doc, id) {
  if (doc && typeof doc.getElementById === "function") {
    return doc.getElementById(id);
  }
  return null;
}

function clearChildren(el) {
  if (!el) {
    return;
  }
  if (typeof el.replaceChildren === "function") {
    el.replaceChildren();
  } else {
    el.textContent = "";
  }
}

function countText(n) {
  return isNum(n) ? String(n) : "unknown";
}

// ok -> good, down -> bad, everything else (unknown, degraded) -> warn.
function toneForStatus(status) {
  if (status === "ok") {
    return "good";
  }
  if (status === "down") {
    return "bad";
  }
  return "warn";
}

function toneForCameraState(state) {
  if (state === "recording") {
    return "good";
  }
  if (state === "silent") {
    return "bad";
  }
  // never_recorded and unresolved: suspicious, but not proven dead.
  return "warn";
}

function toneForStoreState(state) {
  if (state === "full" || state === "unmounted") {
    return "bad";
  }
  if (state === "filling") {
    return "warn";
  }
  if (state === "ok") {
    return "good";
  }
  return "dim";
}

// n null -> "not measured". 0 is a real measurement of nothing -> "0 B".
// Otherwise B / KB / MB / GB / TB at 1000, one decimal place from KB up.
// The unit is always in the string.
export function formatBytes(n) {
  if (n === null || n === undefined) {
    return NOT_MEASURED;
  }
  if (n === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let u = 0;
  while (value >= 1000 && u < units.length - 1) {
    value = value / 1000;
    u += 1;
  }
  if (u === 0) {
    return value + " B";
  }
  return value.toFixed(1) + " " + units[u];
}

// n null -> "not measured". 0 kbps is a real measurement. >= 1000 -> Mbps.
export function formatKbps(n) {
  if (n === null || n === undefined) {
    return NOT_MEASURED;
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + " Mbps";
  }
  return n + " kbps";
}

const two = (n) => String(n).padStart(2, "0");

// Local wall-clock "HH:MM" for a UTC ISO string. Mirrors review.html's
// localTime() -- same page family, same reading, no reason to invent a
// second convention.
function localTime(utc) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) {
    return String(utc);
  }
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "HH:MM" when the footage starts on the same local day as the snapshot, and
// "Sat 19 Sep 22:03" when it does not: a bare clock time from two days ago
// reads as this morning. The snapshot's own moment is the start plus the
// hours held, so this needs no clock of its own. Hours it cannot read get
// the date, since leaving it off is the misleading choice.
export function localWhen(utc, heldHours) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) {
    return String(utc);
  }
  const at = isNum(heldHours) ? new Date(d.getTime() + heldHours * 3_600_000) : null;
  const sameDay = at !== null && at.getFullYear() === d.getFullYear() &&
    at.getMonth() === d.getMonth() && at.getDate() === d.getDate();
  if (sameDay) {
    return localTime(utc);
  }
  return DAY_NAMES[d.getDay()] + " " + d.getDate() + " " + MONTH_NAMES[d.getMonth()] + " " + localTime(utc);
}

// h < 48 -> hours to one decimal; at or above -> days. 48 is picked so a
// single day of footage still reads as "24.0 hours" -- see contracts/
// footageHeld.ts for why a drive can honestly answer in hours, days, a
// keep-for limit or a floor, and never a bare number with no basis.
export function formatHours(h) {
  if (!isNum(h)) {
    return NOT_MEASURED;
  }
  if (h < 48) {
    return h.toFixed(1) + " hours";
  }
  return (h / 24).toFixed(1) + " days";
}

// "at least" only for a floor (basis "at_least"): the other three bases are
// each a real, complete answer and get no hedge.
function basisPrefix(basis) {
  return basis === "at_least" ? "at least " : "";
}

// The suffix says what KIND of number this is. The same "31.6 hours" means a
// measured fact if the drive is full, a modelled guess if it is not, and a
// policy limit if the keep-for setting is what actually deletes first --
// three different things an installer would act on differently.
function basisSuffix(basis) {
  if (basis === "measured") return " (measured)";
  if (basis === "projected") return " (estimate)";
  if (basis === "age_limit") return " (keep-for limit)";
  return ""; // "at_least" already said so via the prefix.
}

function formatRetentionHours(hours, basis) {
  return basisPrefix(basis) + formatHours(hours) + basisSuffix(basis);
}

// seconds null -> "never" (this camera has never sealed a segment).
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) {
    return "never";
  }
  const s = Math.floor(seconds);
  if (s < 60) {
    return s + "s";
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return m + "m " + (s % 60) + "s";
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return h + "h " + (m % 60) + "m";
  }
  const d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h";
}

// kind "unknown" -> the server's message, plus the unmeasured camera ids
// when given. kind "ok" with an hours figure -> formatRetentionHours, so
// "at least 4.3 hours" and "31.6 hours (estimate)" carry their basis on
// screen and are never mistaken for each other. kind "ok" WITHOUT an hours
// figure is an older server's {kind,days,totalKbps,camerasCounted} shape,
// from before contracts/footageHeld.ts existed: still worth the number,
// just with no basis to show.
export function retentionText(retention) {
  if (!retention || typeof retention !== "object") {
    return NOT_MEASURED;
  }
  if (retention.kind === "unknown") {
    let text = (typeof retention.message === "string" && retention.message)
      ? retention.message
      : "retention unknown";
    const ids = retention.unmeasuredCameraIds;
    if (Array.isArray(ids) && ids.length > 0) {
      text = text + " (" + ids.join(", ") + ")";
    }
    return text;
  }
  if (isNum(retention.hours)) {
    return formatRetentionHours(retention.hours, retention.basis);
  }
  if (!isNum(retention.days)) {
    return NOT_MEASURED;
  }
  return retention.days.toFixed(1) + " days";
}

function tdEl(doc, label, text, tone) {
  const cell = doc.createElement("td");
  if (typeof cell.setAttribute === "function") {
    cell.setAttribute("data-label", label);
  }
  cell.textContent = text;
  if (tone) {
    cell.className = tone;
  }
  return cell;
}

// Finds this camera's entry in retention.cameras (contracts/footageHeld.ts's
// CameraFootage[]), matched by cameraId. Returns null when there is no
// cameras array at all -- an older health.json's retention is just
// {kind,days,totalKbps,camerasCounted} -- so the caller can skip the
// retention cell silently instead of guessing at a shape that is not there.
function retentionCameraFor(retention, cameraId) {
  const cams = (retention && Array.isArray(retention.cameras)) ? retention.cameras : null;
  if (!cams) {
    return null;
  }
  return cams.find((c) => c && c.cameraId === cameraId) ?? null;
}

// Two lines from the footage-held record, never blended: how far back this
// camera's footage actually goes, and what it keeps -- or, if that was
// refused, the sentence saying why, in place of a number this camera cannot
// honestly report (rule 10: refuse rather than guess).
function retentionCell(doc, cam, retention) {
  const cell = doc.createElement("td");
  if (typeof cell.setAttribute === "function") {
    cell.setAttribute("data-label", "Retention");
  }
  const rc = retentionCameraFor(retention, cam.cameraId);
  if (!rc) {
    return cell;
  }
  // heldFromUtc null means nothing is sealed for this camera yet: there is
  // no honest "footage back to" line to print, so it is left out rather
  // than printed as an hour count of zero.
  if (rc.heldFromUtc) {
    const held = doc.createElement("div");
    held.textContent = "footage back to " + localWhen(rc.heldFromUtc, rc.heldHours) +
      " (" + formatHours(rc.heldHours) + ")";
    cell.appendChild(held);
  }
  const keeps = doc.createElement("div");
  if (rc.keeps && rc.keeps.ok === false) {
    keeps.textContent = rc.keeps.message;
    keeps.className = "warn";
  } else if (rc.keeps) {
    keeps.textContent = "keeps " + formatRetentionHours(rc.keeps.hours, rc.keeps.basis);
  }
  cell.appendChild(keeps);
  return cell;
}

function cameraRow(doc, cam, retention) {
  const tr = doc.createElement("tr");
  const name = (typeof cam.cameraId === "string" && cam.cameraId)
    ? cam.cameraId
    : "unknown camera";
  tr.appendChild(tdEl(doc, "Camera", name, ""));
  const state = (typeof cam.state === "string" && cam.state)
    ? cam.state
    : "unknown";
  tr.appendChild(tdEl(doc, "State", state, toneForCameraState(state)));
  if (typeof cam.detail === "string" && cam.detail) {
    tr.appendChild(tdEl(doc, "Detail", cam.detail, ""));
  } else {
    tr.appendChild(tdEl(doc, "Detail", "no detail", "dim"));
  }
  tr.appendChild(tdEl(doc, "Measured", formatKbps(cam.measuredKbps),
    isNum(cam.measuredKbps) ? "" : "dim"));
  tr.appendChild(tdEl(doc, "Segments", countText(cam.segments),
    isNum(cam.segments) ? "" : "dim"));
  tr.appendChild(tdEl(doc, "Size", formatBytes(cam.bytes),
    isNum(cam.bytes) ? "" : "dim"));
  tr.appendChild(tdEl(doc, "Last sealed", formatDuration(cam.secondsSinceSealed),
    isNum(cam.secondsSinceSealed) ? "" : "dim"));
  tr.appendChild(retentionCell(doc, cam, retention));
  return tr;
}

function appendFigure(parent, doc, label, value, tone) {
  const item = doc.createElement("div");
  item.className = "figure";
  const valueEl = doc.createElement("div");
  valueEl.className = tone ? "figure-value " + tone : "figure-value";
  valueEl.textContent = value;
  const labelEl = doc.createElement("div");
  labelEl.className = "figure-label";
  labelEl.textContent = label;
  item.appendChild(valueEl);
  item.appendChild(labelEl);
  parent.appendChild(item);
}

// Finds this drive's entry in retention.stores (contracts/footageHeld.ts's
// StoreFootage[]), matched by root. Null when retention carries no stores
// array at all, same reasoning as retentionCameraFor above.
function retentionStoreFor(retention, root) {
  const stores = (retention && Array.isArray(retention.stores)) ? retention.stores : null;
  if (!stores) {
    return null;
  }
  return stores.find((s) => s && s.root === root) ?? null;
}

function storeBlock(doc, store, retention) {
  const box = doc.createElement("div");
  box.className = "store";
  const head = doc.createElement("div");
  head.className = "store-head";
  const rootEl = doc.createElement("span");
  rootEl.className = "store-root";
  rootEl.textContent = (typeof store.root === "string" && store.root)
    ? store.root
    : "unknown store";
  head.appendChild(rootEl);
  const state = (typeof store.state === "string" && store.state)
    ? store.state
    : "unknown";
  const stateEl = doc.createElement("span");
  stateEl.className = "store-state " + toneForStoreState(state);
  stateEl.textContent = state;
  head.appendChild(stateEl);
  box.appendChild(head);
  if (isNum(store.usedFraction)) {
    const bar = doc.createElement("div");
    bar.className = "bar";
    const fill = doc.createElement("div");
    fill.className = "bar-fill " + toneForStoreState(state);
    if (fill.style) {
      fill.style.width = (Math.max(0, Math.min(1, store.usedFraction)) * 100) + "%";
    }
    bar.appendChild(fill);
    box.appendChild(bar);
    const usage = doc.createElement("div");
    usage.className = "store-usage";
    usage.textContent = formatBytes(store.usedBytes) + " / " + formatBytes(store.totalBytes);
    box.appendChild(usage);
  } else {
    // usedFraction null: no bar at all. An empty bar reads as "disk is
    // empty", which is the exact opposite of the truth.
    const usage = doc.createElement("div");
    usage.className = "store-usage dim";
    usage.textContent = NOT_MEASURED;
    box.appendChild(usage);
  }

  // What eviction is actually doing on this drive, from footageHeld: full
  // means it is deleting the oldest footage right now to make room; false
  // means there is still room; null (unmeasured) says nothing at all,
  // because a guessed fill state is worse than no fill state.
  const rs = retentionStoreFor(retention, store.root);
  if (rs) {
    if (rs.full === true) {
      const line = doc.createElement("div");
      line.className = "store-usage bad";
      line.textContent = "full — oldest footage is deleted to make room";
      box.appendChild(line);
    } else if (rs.full === false) {
      const line = doc.createElement("div");
      line.className = "store-usage dim";
      line.textContent = "still filling";
      box.appendChild(line);
    }
    if (isNum(rs.foreignBytes) && rs.foreignBytes > 0) {
      const line = doc.createElement("div");
      line.className = "store-usage warn";
      line.textContent = formatBytes(rs.foreignBytes) +
        " from cameras no longer configured, cleared first";
      box.appendChild(line);
    }
  }
  return box;
}

// Fills the System page from a /health payload using only getElementById
// and plain DOM calls -- never innerHTML, since camera ids come from a
// config file an installer typed and a stray < must not break the page.
// Never throws on null fields, an empty camera list or an empty store
// list; anything missing is rendered as words, never as zero.
export function renderHealth(doc, health) {
  const h = (health && typeof health === "object") ? health : {};

  const siteEl = byId(doc, "siteId");
  if (siteEl) {
    siteEl.textContent = (typeof h.siteId === "string" && h.siteId)
      ? h.siteId
      : "unknown site";
  }

  const status = (typeof h.status === "string" && h.status)
    ? h.status
    : "unknown";
  const overallEl = byId(doc, "overall");
  if (overallEl) {
    overallEl.textContent = status.toUpperCase();
    overallEl.className = "chip " + toneForStatus(status);
  }

  const asOfEl = byId(doc, "asOf");
  if (asOfEl) {
    const at = h.atUtc ? new Date(h.atUtc) : null;
    if (at && !Number.isNaN(at.getTime())) {
      asOfEl.textContent = "as of " + at.toLocaleTimeString();
    } else {
      asOfEl.textContent = "as of unknown";
    }
  }

  const totalsEl = byId(doc, "totals");
  if (totalsEl) {
    const t = (h.totals && typeof h.totals === "object") ? h.totals : {};
    clearChildren(totalsEl);
    appendFigure(totalsEl, doc, "cameras", countText(t.cameras), "");
    appendFigure(totalsEl, doc, "recording", countText(t.recording), "");
    appendFigure(totalsEl, doc, "silent", countText(t.silent),
      isNum(t.silent) && t.silent > 0 ? "warn" : "");
    appendFigure(totalsEl, doc, "unresolved", countText(t.unresolved),
      isNum(t.unresolved) && t.unresolved > 0 ? "bad" : "");
    appendFigure(totalsEl, doc, "segments", countText(t.segments), "");
    appendFigure(totalsEl, doc, "total size", formatBytes(t.bytes), "");
    appendFigure(totalsEl, doc, "retention", retentionText(h.retention), "");
  }

  const recorderEl = byId(doc, "recorder");
  if (recorderEl) {
    if (h.recorderRunning === true) {
      recorderEl.textContent = "Recorder: running";
      recorderEl.className = "good";
    } else if (h.recorderRunning === false) {
      recorderEl.textContent = "Recorder: stopped";
      recorderEl.className = "bad";
    } else {
      // null is NOT "stopped": an unknown recorder state gets words and
      // warning colours, never a verdict the server did not give.
      recorderEl.textContent = "Recorder: unknown";
      recorderEl.className = "warn";
    }
  }

  const camerasEl = byId(doc, "cameras");
  if (camerasEl) {
    const cameras = Array.isArray(h.cameras) ? h.cameras : [];
    clearChildren(camerasEl);
    for (const entry of cameras) {
      const cam = (entry && typeof entry === "object") ? entry : {};
      camerasEl.appendChild(cameraRow(doc, cam, h.retention));
    }
  }

  const storesEl = byId(doc, "stores");
  if (storesEl) {
    const stores = Array.isArray(h.stores) ? h.stores : [];
    clearChildren(storesEl);
    for (const entry of stores) {
      const store = (entry && typeof entry === "object") ? entry : {};
      storesEl.appendChild(storeBlock(doc, store, h.retention));
    }
  }
}

function showPollError(doc, message) {
  const el = byId(doc, "pollError");
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
}

function hidePollError(doc) {
  const el = byId(doc, "pollError");
  if (el) {
    el.hidden = true;
  }
}

// Polls GET /health, renders it, and keeps the page honest on failure:
// a network error, a non-2xx reply or bad JSON shows #pollError and
// leaves the last good data on screen -- blanking the page would make
// an installer conclude the NVR died when one poll merely failed. A
// successful poll hides #pollError again. Every dependency arrives via
// opts so a harness can drive it without a browser.
export function startSystemPage(opts) {
  const o = (opts && typeof opts === "object") ? opts : {};
  const doc = o.doc;
  const fetchFn = o.fetchFn;
  const intervalMs = isNum(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : 5000;
  const setIntervalFn = typeof o.setIntervalFn === "function"
    ? o.setIntervalFn
    : (typeof setInterval === "function" ? setInterval : null);
  const clearIntervalFn = typeof o.clearIntervalFn === "function"
    ? o.clearIntervalFn
    : (typeof clearInterval === "function" ? clearInterval : null);

  let timer = null;
  let haveData = false;

  async function poll() {
    try {
      if (typeof fetchFn !== "function") {
        throw new Error("no fetch function");
      }
      const res = await fetchFn("/health");
      const code = (res && isNum(res.status)) ? res.status : null;
      const failed = !res
        || (typeof res.ok === "boolean" && !res.ok)
        || (code !== null && (code < 200 || code > 299));
      if (failed) {
        throw new Error("HTTP " + (code !== null ? code : "request failed"));
      }
      const health = await res.json();
      renderHealth(doc, health);
      haveData = true;
      hidePollError(doc);
    } catch (err) {
      const reason = (err && typeof err.message === "string" && err.message)
        ? err.message
        : "unknown error";
      const suffix = haveData ? "showing last good data" : "no data received yet";
      showPollError(doc, "health poll failed: " + reason + " (" + suffix + ")");
    }
  }

  // The first poll's promise is kept and handed back as `ready`. Without it a
  // caller -- the harness above all -- has no way to know the page has been
  // drawn once, so it inspects the DOM while the fetch is still in flight and
  // reads "never rendered" off a page that renders perfectly.
  const ready = poll();
  if (setIntervalFn) {
    timer = setIntervalFn(poll, intervalMs);
  }

  return {
    ready,
    // On demand, so a caller can drive a failure-and-recovery sequence
    // without waiting out the interval.
    poll,
    stop: function () {
      if (timer !== null && typeof clearIntervalFn === "function") {
        clearIntervalFn(timer);
      }
      timer = null;
    }
  };
}

// Browser bootstrap. Runs only when the real System page is in the DOM;
// when the harness imports this module it injects its own doc and fetch
// via startSystemPage opts, so importing has no side effects there.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("overall")) {
  startSystemPage({
    doc: document,
    fetchFn: function (url) {
      return fetch(url);
    }
  });
}
