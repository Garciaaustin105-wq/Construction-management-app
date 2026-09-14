/** The health alerts banner, shared by the live and review pages, served as
 *  /ui/alert-banner.js. The failures feared: alerts that stopped updating shown
 *  as if all is well; a /alerts that could not be read shown as nothing; text
 *  from the response reaching the page as markup. */

const CHECKS = ["current", "stale", "never", "unreadable"];

const LABELS = {
  clock_suspect: "Box clock",
  recorder_stale: "Recorder",
  retention_unknown: "Retention",
  camera_not_recording: "Camera",
  disk_missing: "Disk missing",
  disk_filling: "Disk filling",
  quarantine_large: "Quarantine",
};

/**
 * What the banner shows, from any parsed GET /alerts body (or null when the
 * fetch or the JSON failed). Pure; never throws. Returns { show, level, lines },
 * lines being [{ level, text }], each level "problem" or "notice".
 * - body not a non-null, non-array object, or body.ok !== true, or body.check not
 *   in CHECKS, or body.alerts not an array:
 *   { show: true, level: "problem", lines: [{ level: "problem", text: "Health alerts could not be read" }] }.
 * - Otherwise, with reason = body.reason when a string, else "no reason given", lines start:
 *   check "never": { level: "notice", text: "Health alerts have not run yet" };
 *   check "unreadable": { level: "problem", text: "Health alerts could not be read: " + reason };
 *   check "stale": { level: "problem", text: "Health alerts have stopped updating: " + reason };
 *   check "current": nothing.
 * - Then every alert with state "raised", in body order, as { level: "problem", text: alertText(a) };
 *   then every alert with state "unknown", in body order, as { level: "notice", text: "Cannot tell: " + alertText(a) }.
 *   alertText(a) = (LABELS[a.id] ?? a.id) + (a.subject !== "recorder" ? " " + a.subject : "") + ": " + a.value.
 *   Skip any alert that is not a non-null object, or whose id, subject, value or state is not a string.
 * - Then, when Number.isInteger(body.discarded) && body.discarded > 0:
 *   { level: "notice", text: body.discarded + (body.discarded === 1 ? " alert record" : " alert records") + " could not be read" }.
 * - show = lines.length > 0; level = "problem" when some line is "problem", else "notice".
 */
export function planAlertBanner(body) {
  const isObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
  if (!isObject(body) || body.ok !== true || !CHECKS.includes(body.check) || !Array.isArray(body.alerts)) {
    const lines = [{ level: "problem", text: "Health alerts could not be read" }];
    return { show: true, level: "problem", lines };
  }
  const reason = typeof body.reason === "string" ? body.reason : "no reason given";
  const lines = [];
  switch (body.check) {
    case "never":
      lines.push({ level: "notice", text: "Health alerts have not run yet" });
      break;
    case "unreadable":
      lines.push({ level: "problem", text: "Health alerts could not be read: " + reason });
      break;
    case "stale":
      lines.push({ level: "problem", text: "Health alerts have stopped updating: " + reason });
      break;
    case "current":
      break;
  }
  const alerts = body.alerts.filter((a) => isObject(a) && typeof a.id === "string" && typeof a.subject === "string"
    && typeof a.value === "string" && typeof a.state === "string");
  const alertText = (a) => (Object.prototype.hasOwnProperty.call(LABELS, a.id) ? LABELS[a.id] : a.id)
    + (a.subject !== "recorder" ? " " + a.subject : "") + ": " + a.value;
  for (const a of alerts) if (a.state === "raised") lines.push({ level: "problem", text: alertText(a) });
  for (const a of alerts) if (a.state === "unknown") lines.push({ level: "notice", text: "Cannot tell: " + alertText(a) });
  if (Number.isInteger(body.discarded) && body.discarded > 0) {
    const discText = body.discarded + (body.discarded === 1 ? " alert record" : " alert records") + " could not be read";
    lines.push({ level: "notice", text: discText });
  }
  const level = lines.some((l) => l.level === "problem") ? "problem" : "notice";
  return { show: lines.length > 0, level, lines };
}

/**
 * Draws a plan into el, text only (never innerHTML). el.hidden = !plan.show;
 * el.className = "alertBanner " + plan.level; then el.replaceChildren(...) with one
 * doc.createElement("div") per line, each with className = line.level and
 * textContent = line.text, in order.
 */
export function renderAlertBanner(el, plan, doc) {
  el.hidden = !plan.show;
  el.className = "alertBanner " + plan.level;
  el.replaceChildren(...plan.lines.map((line) => {
    const div = doc.createElement("div");
    div.className = line.level;
    div.textContent = line.text;
    return div;
  }));
}

/**
 * Starts the banner on a page. When el is null or undefined, returns null and
 * does nothing else (a page without the banner element, or a harness).
 * Otherwise defines async refresh(): body = null; try { const res = await fetchFn("/alerts");
 * body = await res.json(); } catch { body = null; } then
 * renderAlertBanner(el, planAlertBanner(body), doc). Calls refresh() once now (not awaited),
 * and returns setIntervalFn(refresh, intervalMs).
 */
export function startAlertBanner(el, { fetchFn = globalThis.fetch, doc = globalThis.document,
  setIntervalFn = globalThis.setInterval, intervalMs = 60_000 } = {}) {
  if (!el) { return null; }
  const refresh = async () => {
    let body = null;
    try {
      if (typeof fetchFn === "function") {
        const res = await fetchFn("/alerts");
        if (res && typeof res.json === "function") {
          body = await res.json();
        }
      }
    } catch (e) {
      body = null;
    }
    renderAlertBanner(el, planAlertBanner(body), doc);
  };
  refresh();
  if (typeof setIntervalFn === "function") {
    return setIntervalFn(refresh, intervalMs);
  }
  return null;
}
