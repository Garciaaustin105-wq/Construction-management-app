/** The health alerts banner. The failures feared: alerts that stopped updating
 *  shown as all well; an unreadable /alerts shown as nothing; response text
 *  reaching the page as markup. */
import { planAlertBanner, renderAlertBanner, startAlertBanner } from "../agent/ui/alert-banner.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("alert banner");

const alert = (over = {}) => ({ key: "disk_filling:/d0", id: "disk_filling", subject: "/d0", state: "raised",
  since: "2026-09-14T11:00:00.000Z", badStreak: 5, goodStreak: 0, value: "95.0% used", ...over });
const body = (over = {}) => ({ ok: true, check: "current", checkedUtc: "2026-09-14T12:00:00.000Z", reason: null, alerts: [], discarded: 0, ...over });
const P = (text) => ({ level: "problem", text });
const N = (text) => ({ level: "notice", text });
const couldNot = { show: true, level: "problem", lines: [P("Health alerts could not be read")] };

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.className = ""; this.textContent = ""; }
  replaceChildren(...cs) { this.children = cs; }
  set innerHTML(_) { throw new Error("the banner must not use innerHTML"); }
}
const doc = { createElement: (tag) => new El(tag) };
const shown = (el) => [el.hidden, el.className, el.children.map((c) => [c.tag, c.className, c.textContent])];

await check("all well: a current check with everything clear shows nothing", () => {
  eq(planAlertBanner(body({ alerts: [alert({ state: "clear" })] })), { show: false, level: "notice", lines: [] }, "hidden");
});

await check("THE FEARED ONE: a stopped check is never shown as all well, and its last alerts stay up", () => {
  eq(planAlertBanner(body({ check: "stale", reason: "the last alerts check was 600 s ago", alerts: [alert()] })),
    { show: true, level: "problem", lines: [P("Health alerts have stopped updating: the last alerts check was 600 s ago"), P("Disk filling /d0: 95.0% used")] }, "stale");
  eq(planAlertBanner(body({ check: "never", reason: "the alerts check has not run" })),
    { show: true, level: "notice", lines: [N("Health alerts have not run yet")] }, "never ran");
  eq(planAlertBanner(body({ check: "unreadable", reason: "alerts.json is unreadable: bad" })).lines,
    [P("Health alerts could not be read: alerts.json is unreadable: bad")], "unreadable");
  eq(planAlertBanner(body({ check: "stale", reason: 7 })).lines, [P("Health alerts have stopped updating: no reason given")], "a reason that is not text");
});

await check("THE FEARED ONE: a /alerts that could not be read or trusted is shown, not skipped", () => {
  for (const [what, b] of [["null (fetch failed)", null], ["an array", []], ["ok false", body({ ok: false })],
    ["a check nobody named", body({ check: "fine" })], ["no alerts list", body({ alerts: undefined })], ["text", "<b>hi</b>"]]) {
    eq(planAlertBanner(b), couldNot, what);
  }
});

await check("raised first, then what could not be measured, then what was discarded", () => {
  const b = body({ discarded: 2, alerts: [
    alert({ key: "clock_suspect:recorder", id: "clock_suspect", subject: "recorder", state: "unknown", value: "no health report" }),
    alert(),
    alert({ key: "camera_not_recording:cam-2", id: "camera_not_recording", subject: "cam-2", value: "no segment for 12 min" }),
    alert({ key: "some_new_alert:recorder", id: "some_new_alert", subject: "recorder", state: "unknown", value: "v" }),
    { key: "junk" }, null, alert({ value: 95 }),
  ] });
  eq(planAlertBanner(b), { show: true, level: "problem", lines: [
    P("Disk filling /d0: 95.0% used"), P("Camera cam-2: no segment for 12 min"),
    N("Cannot tell: Box clock: no health report"), N("Cannot tell: some_new_alert: v"), N("2 alert records could not be read"),
  ] }, "order, labels, unknown ids named as they are, junk skipped");
  eq(planAlertBanner(body({ discarded: 1 })), { show: true, level: "notice", lines: [N("1 alert record could not be read")] }, "one, singular");
});

await check("THE FEARED ONE: response text reaches the page as text, never as markup", () => {
  const el = new El("div");
  renderAlertBanner(el, planAlertBanner(body({ alerts: [alert({ subject: "<img src=x onerror=alert(1)>" })] })), doc);
  eq(shown(el), [false, "alertBanner problem", [["div", "problem", "Disk filling <img src=x onerror=alert(1)>: 95.0% used"]]], "drawn as text");
  renderAlertBanner(el, planAlertBanner(body()), doc);
  eq(shown(el), [true, "alertBanner notice", []], "cleared and hidden when all is well");
});

await check("startAlertBanner fetches /alerts, redraws on its interval, and survives a failed fetch", async () => {
  eq(startAlertBanner(null, { fetchFn: () => { throw new Error("must not fetch"); }, doc, setIntervalFn: () => { throw new Error("must not schedule"); } }), null, "no element, nothing started");
  const el = new El("div");
  const urls = [];
  let answer = body({ alerts: [alert()] });
  let tick = null;
  const handle = startAlertBanner(el, {
    doc,
    fetchFn: async (u) => { urls.push(u); if (answer === "fail") throw new TypeError("fetch failed"); return { json: async () => answer }; },
    setIntervalFn: (fn, ms) => { tick = [fn, ms]; return "handle-1"; },
  });
  eq([handle, tick?.[1]], ["handle-1", 60_000], "scheduled every 60 s");
  await new Promise((r) => setTimeout(r, 10));
  eq([urls, shown(el)[2].map((c) => c[2])], [["/alerts"], ["Disk filling /d0: 95.0% used"]], "first draw");
  answer = "fail";
  await tick[0]();
  eq([urls.length, shown(el)], [2, [false, "alertBanner problem", [["div", "problem", "Health alerts could not be read"]]]], "a failed fetch says so");
});

report("alert banner");
