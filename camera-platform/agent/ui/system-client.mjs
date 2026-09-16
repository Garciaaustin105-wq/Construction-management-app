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

// kind "ok" -> "2.8 days" (one decimal, and the word days). kind
// "unknown" -> the server's message, plus the unmeasured camera ids
// when given. Never a number of days we do not actually have.
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

function cameraRow(doc, cam) {
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

function storeBlock(doc, store) {
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
      camerasEl.appendChild(cameraRow(doc, cam));
    }
  }

  const storesEl = byId(doc, "stores");
  if (storesEl) {
    const stores = Array.isArray(h.stores) ? h.stores : [];
    clearChildren(storesEl);
    for (const entry of stores) {
      const store = (entry && typeof entry === "object") ? entry : {};
      storesEl.appendChild(storeBlock(doc, store));
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
