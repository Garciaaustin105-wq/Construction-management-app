/**
 * The Cloud section on the System page (agent/ui/cloud-client.mjs),
 * CLOUD-LINK-SPEC.md section D+E ("page" bullet), run without a browser.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are -- see
 * AGENTS.md); run it directly: `node harness/cloudPage.harness.mjs`.
 *
 * THE FEARED FAILURES:
 *  - a claim code still shown once claimed, or once its own code expired --
 *    every render takes the server's `claimCode`/`codeExpired` as given,
 *    never a value cached from an earlier render.
 *  - a store account (no system.manage) seeing a Cloud form it can never
 *    save: GET /cloud-link answers 403 for them, and the section must be
 *    removed, not left half-drawn.
 *  - "never checked in" rendering as a blank or a guessed time.
 *  - a client with no browser bootstrap passing every check that drives its
 *    exported functions directly, while the real page never fetches
 *    anything at all (camera-page-bootstrap-lesson, agent bus, 2026-09-26).
 *  - the display text drifting from what contracts/cloudLink.ts's own
 *    cloudStatusView actually produces -- the "against the real contract"
 *    checks below feed dist/cloudLink.js's own output straight into this
 *    client's display functions, not just hand-built literals.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { check, eq, report } from "./_assert.mjs";

const root = process.cwd();
const client = await import(pathToFileURL(join(root, "agent/ui/cloud-client.mjs")).href);
const contract = await import(pathToFileURL(join(root, "dist/cloudLink.js")).href);

console.log("cloud page");

/* ------------------------------------------------------------------ */
/* A small fake DOM: just enough for buildCloudSection's own tree.     */
/* Copied from harness/sitePage.harness.mjs's own fake DOM -- same     */
/* shape, so a future shared helper can lift both without behaviour    */
/* change.                                                              */
/* ------------------------------------------------------------------ */

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.style = {};
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.hidden = false;
    this._text = "";
    this._listeners = new Map();
    this._attrs = new Map();
  }
  set innerHTML(_) {
    throw new Error("cloud-client.mjs must not use innerHTML");
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...kids) {
    for (const k of kids) this.appendChild(k);
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...kids) {
    for (const c of this.children.slice()) this.removeChild(c);
    this.append(...kids);
  }
  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
  set textContent(v) {
    this._text = v === null || v === undefined ? "" : String(v);
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
    if (name === "id") this.id = String(value);
    if (name === "hidden") this.hidden = true;
  }
  getAttribute(name) {
    return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null;
  }
  addEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    list.push(fn);
    this._listeners.set(type, list);
  }
  fire(type) {
    for (const fn of this._listeners.get(type) ?? []) fn({ target: this });
  }
}

function all(el, out = []) {
  out.push(el);
  for (const c of el.children) all(c, out);
  return out;
}
const byIdIn = (root, id) => all(root).find((e) => e.id === id);

function fakeDoc() {
  const body = new FakeEl("div");
  return {
    _body: body,
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => (byIdIn(body, id) ?? null),
    mount(el) { body.appendChild(el); },
  };
}

function makeFetchFrom(routes) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      const key = `${(init && init.method) || "GET"} ${url.split("?")[0]}`;
      const handler = routes[key];
      if (!handler) return { ok: false, status: 404, json: async () => ({ ok: false }) };
      return handler(url, init);
    },
  };
}

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mountedPage() {
  const doc = fakeDoc();
  const rootEl = new FakeEl("div");
  rootEl.setAttribute("id", "cloudSectionRoot");
  doc.mount(rootEl);
  return { doc, rootEl };
}

/* ------------------------------------------------------------------ */
/* Pure helpers -- hand-built literals.                                 */
/* ------------------------------------------------------------------ */

check("describeCloudLinkReason never echoes a raw code it does not recognise, but never hides one either", () => {
  eq(client.describeCloudLinkReason("bad_enabled"), "must be on or off");
  eq(client.describeCloudLinkReason("url_has_credentials").includes("username"), true);
  eq(client.describeCloudLinkReason("something_new"), "something_new");
});

check("cloudStateText: off, not_enrolled and claimed are the spec's own literal words", () => {
  eq(client.cloudStateText({ state: "off" }), "Off");
  eq(client.cloudStateText({ state: "not_enrolled" }), "Not enrolled yet");
  eq(client.cloudStateText({ state: "claimed" }), "Claimed");
});

check("cloudStateText: waiting_for_claim, not expired, shows the code and the expiry", () => {
  const text = client.cloudStateText({
    state: "waiting_for_claim", claimCode: "ABCD-EFGH-3",
    codeExpiresUtc: "2026-09-29T00:00:00.000Z", codeExpired: false,
  });
  eq(text.includes("ABCD-EFGH-3"), true, text);
  eq(text.startsWith("Waiting for the installer to claim it"), true, text);
});

check("REQUIRED, THE FEARED ONE: cloudStateText never shows a claim code once codeExpired is true -- an expired code is its own sentence, not the live one", () => {
  const text = client.cloudStateText({
    state: "waiting_for_claim", claimCode: null,
    codeExpiresUtc: "2026-09-27T00:00:00.000Z", codeExpired: true,
  });
  eq(text.includes("ABCD"), false, text);
  eq(text.toLowerCase().includes("expired"), true, text);
});

check("REQUIRED, THE FEARED ONE: cloudStateText never shows a claim code once claimed, even if the caller's payload still carried one by mistake", () => {
  // cloudStatusView itself always nulls claimCode once claimed -- this
  // proves the CLIENT does not independently go looking for one when the
  // state says otherwise, which is the layer that would actually leak a
  // stale code onto the page.
  const text = client.cloudStateText({ state: "claimed", claimCode: "ZZZZ-ZZZZ-9", codeExpired: false });
  eq(text, "Claimed", "the state word alone, never a code the caller had no business sending at this state");
});

check("checkinText: never checked in reads the word 'never', not a blank or a guessed time", () => {
  eq(client.checkinText({ lastCheckinUtc: null, lastOutcome: null }), "Last check-in: never");
  eq(client.checkinText({}), "Last check-in: never");
});

check("checkinText: a real check-in shows the time and the outcome", () => {
  const text = client.checkinText({ lastCheckinUtc: "2026-09-28T08:00:00.000Z", lastOutcome: "accepted" });
  eq(text.includes("accepted"), true, text);
  eq(text.includes("never"), false, text);
});

check("deviceIdText: null reads 'not assigned yet', not blank", () => {
  eq(client.deviceIdText({ deviceId: null }), "Device id: not assigned yet");
});

check("deviceIdText: reports the device id regardless of state -- an installer who turned the cloud back off still sees which device this box last enrolled as", () => {
  eq(client.deviceIdText({ state: "off", deviceId: "PLPG3LDH" }), "Device id: PLPG3LDH");
});

check("cloudStateClass never throws on an unrecognised state and falls back to dim", () => {
  eq(client.cloudStateClass("off"), "dim");
  eq(client.cloudStateClass("claimed"), "good");
  eq(client.cloudStateClass("not_enrolled"), "warn");
  eq(client.cloudStateClass("waiting_for_claim"), "warn");
  eq(client.cloudStateClass("something_unknown"), "dim");
});

/* ------------------------------------------------------------------ */
/* Against the REAL contract: cloudStatusView's own output, fed        */
/* straight into this client's display functions.                     */
/* ------------------------------------------------------------------ */

await check("REQUIRED: cloudStateText agrees with contracts/cloudLink.ts's own cloudStatusView for a live waiting_for_claim code", () => {
  const view = contract.cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: {
      url: "https://cloud.example.com", deviceId: "dev-1", claimed: false,
      claimCode: "ABCD-EFGH-3", expiresUtc: "2026-09-29T00:00:00.000Z", atUtc: "2026-09-28T00:00:00.000Z",
    },
    checkin: null,
    nowMs: Date.parse("2026-09-28T12:00:00.000Z"),
  });
  eq(view.codeExpired, false, "sanity: the fixture's own code has not expired yet");
  const text = client.cloudStateText(view);
  eq(text.includes("ABCD-EFGH-3"), true, text);
});

await check("REQUIRED: cloudStateText agrees with the real contract once nowMs passes the code's own expiry -- the code disappears from the text, the state stays the same word", () => {
  const settings = { url: "https://cloud.example.com", enabled: true };
  const enrollment = {
    url: "https://cloud.example.com", deviceId: "dev-1", claimed: false,
    claimCode: "ABCD-EFGH-3", expiresUtc: "2026-09-29T00:00:00.000Z", atUtc: "2026-09-28T00:00:00.000Z",
  };
  const before = contract.cloudStatusView({ settings, enrollment, checkin: null, nowMs: Date.parse("2026-09-28T12:00:00.000Z") });
  const after = contract.cloudStatusView({ settings, enrollment, checkin: null, nowMs: Date.parse("2026-09-30T00:00:00.000Z") });
  eq(before.state, "waiting_for_claim");
  eq(after.state, "waiting_for_claim", "state does not change on its own just because the code expired");
  eq(client.cloudStateText(before).includes("ABCD-EFGH-3"), true);
  eq(client.cloudStateText(after).includes("ABCD-EFGH-3"), false, client.cloudStateText(after));
  eq(client.cloudStateText(after).toLowerCase().includes("expired"), true, client.cloudStateText(after));
});

await check("REQUIRED: checkinText/deviceIdText agree with the real contract's off/never-checked-in default", () => {
  const view = contract.cloudStatusView({ settings: contract.DEFAULT_CLOUD_SETTINGS, enrollment: null, checkin: null, nowMs: Date.parse("2026-09-28T00:00:00.000Z") });
  eq(view, { state: "off", deviceId: null, claimCode: null, codeExpiresUtc: null, codeExpired: false, lastCheckinUtc: null, lastOutcome: null });
  eq(client.cloudStateText(view), "Off");
  eq(client.checkinText(view), "Last check-in: never");
  eq(client.deviceIdText(view), "Device id: not assigned yet");
});

/* ------------------------------------------------------------------ */
/* DOM: the section builds, fills, and the store-account 403 hides it. */
/* ------------------------------------------------------------------ */

const OFF_VIEW = { ok: true, settings: { url: null, enabled: false }, state: "off", deviceId: null, claimCode: null, codeExpiresUtc: null, codeExpired: false, lastCheckinUtc: null, lastOutcome: null };

const WAITING_VIEW = {
  ok: true,
  settings: { url: "https://cloud.example.com", enabled: true },
  state: "waiting_for_claim",
  deviceId: "PLPG3LDH",
  claimCode: "ABCD-EFGH-3",
  codeExpiresUtc: "2026-09-29T00:00:00.000Z",
  codeExpired: false,
  lastCheckinUtc: null,
  lastOutcome: null,
};

const CLAIMED_VIEW = {
  ok: true,
  settings: { url: "https://cloud.example.com", enabled: true },
  state: "claimed",
  deviceId: "PLPG3LDH",
  claimCode: null,
  codeExpiresUtc: null,
  codeExpired: false,
  lastCheckinUtc: "2026-09-28T08:00:00.000Z",
  lastOutcome: "accepted",
};

await check("the section fills from GET /cloud-link -- off", async () => {
  const { doc } = mountedPage();
  const { fetchFn, calls } = makeFetchFrom({ "GET /cloud-link": () => jsonRes(200, OFF_VIEW) });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  eq(page.dom.urlInput.value, "", "no address");
  eq(page.dom.enabledBox.checked, false);
  eq(page.dom.stateText.textContent, "Off");
  eq(page.dom.checkinLine.textContent, "Last check-in: never");
  eq(page.dom.deviceLine.textContent, "Device id: not assigned yet");
  eq(calls.some((c) => c.url === "/cloud-link"), true, "it asked for /cloud-link itself");
});

await check("the section fills from GET /cloud-link -- waiting_for_claim shows the address, the switch, the code and the device id", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({ "GET /cloud-link": () => jsonRes(200, WAITING_VIEW) });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  eq(page.dom.urlInput.value, "https://cloud.example.com");
  eq(page.dom.enabledBox.checked, true);
  eq(page.dom.stateText.textContent.includes("ABCD-EFGH-3"), true, page.dom.stateText.textContent);
  eq(page.dom.deviceLine.textContent, "Device id: PLPG3LDH");
});

await check("REQUIRED: once claimed, the section never shows a claim code anywhere in the section's own text", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({ "GET /cloud-link": () => jsonRes(200, CLAIMED_VIEW) });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  eq(page.dom.stateText.textContent, "Claimed");
  eq(page.dom.root.textContent.includes("ABCD"), false, page.dom.root.textContent);
  eq(page.dom.checkinLine.textContent.includes("accepted"), true, page.dom.checkinLine.textContent);
});

await check("REQUIRED: a store account (403 on GET /cloud-link) loses the whole section, not a broken form", async () => {
  const { doc, rootEl } = mountedPage();
  const { fetchFn } = makeFetchFrom({ "GET /cloud-link": () => jsonRes(403, { ok: false, code: "forbidden" }) });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  eq(rootEl.hidden, true, "the whole section is hidden, never a form nobody can save");
});

/* ------------------------------------------------------------------ */
/* Save: POST /cloud-link.                                             */
/* ------------------------------------------------------------------ */

await check("saving posts the form's own address and switch, trimmed, blank address as null", async () => {
  const { doc } = mountedPage();
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, OFF_VIEW),
    "POST /cloud-link": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, ...OFF_VIEW, settings: { url: posted.url, enabled: posted.enabled } });
    },
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.urlInput.value = "  https://cloud.example.com  ";
  page.dom.enabledBox.checked = true;
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted, { url: "https://cloud.example.com", enabled: true }, "trimmed");
});

await check("REQUIRED: a blank address saves as null, never an empty string", async () => {
  const { doc } = mountedPage();
  let posted = null;
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, WAITING_VIEW),
    "POST /cloud-link": (url, init) => {
      posted = JSON.parse(init.body);
      return jsonRes(200, { ok: true, ...OFF_VIEW });
    },
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.urlInput.value = "   ";
  page.dom.enabledBox.checked = false;
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(posted.url, null, "blank means null, not \"\"");
});

await check("REQUIRED: a 400 shows the refusal reason in plain words, never the raw code -- matches agent/cloud-link.mjs's own refuse(res, 400, checked.reason, 'these cloud settings could not be saved') shape exactly (the reason travels in `code`, not a `reason` field)", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, OFF_VIEW),
    "POST /cloud-link": () => jsonRes(400, { ok: false, code: "url_has_credentials", message: "these cloud settings could not be saved" }),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.saveErrors.textContent.includes("username"), true, page.dom.saveErrors.textContent);
  eq(page.dom.saveErrors.textContent.includes("url_has_credentials"), false, "never the raw code");
});

await check("REQUIRED: a 409 over an unreadable cloud.json shows the server's OWN specific message, not a description of a checkCloudSettings reason (this code is not one of the four)", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, OFF_VIEW),
    "POST /cloud-link": () => jsonRes(409, { ok: false, code: "cloud_settings_unreadable", message: "the existing cloud.json cannot be trusted, so this save is refused" }),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.saveErrors.textContent.includes("cannot be trusted"), true, page.dom.saveErrors.textContent);
});

await check("REQUIRED: a save that cleared the old enrolment says so, and refreshes the state from a real GET -- POST /cloud-link's own success body (agent/cloud-link.mjs) carries only { settings, enrollmentCleared }, never the state view", async () => {
  const { doc } = mountedPage();
  let getCount = 0;
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => {
      getCount += 1;
      // The FIRST GET (page load) sees the old, still-claimed state; the
      // SECOND GET (after the save reloads) sees the address changed and
      // the enrolment gone -- proving the displayed state comes from this
      // reload, not from the POST response (which never carried it).
      return getCount === 1 ? jsonRes(200, CLAIMED_VIEW) : jsonRes(200, {
        ok: true, settings: { url: "https://new-cloud.example.com", enabled: true },
        state: "not_enrolled", deviceId: null, claimCode: null, codeExpiresUtc: null,
        codeExpired: false, lastCheckinUtc: null, lastOutcome: null, problem: null,
      });
    },
    "POST /cloud-link": () => jsonRes(200, { ok: true, settings: { url: "https://new-cloud.example.com", enabled: true }, enrollmentCleared: true }),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  eq(page.dom.stateText.textContent, "Claimed", "sanity: the first load shows the old state");
  page.dom.urlInput.value = "https://new-cloud.example.com";
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(getCount, 2, "the save re-fetched /cloud-link");
  eq(page.dom.stateText.textContent, "Not enrolled yet", "the reloaded state, not a guess from the POST body");
  eq(page.dom.saveStatus.textContent.toLowerCase().includes("clear"), true, page.dom.saveStatus.textContent);
});

await check("a save that did NOT clear the enrolment reads a plain 'Saved.', not the clearing sentence", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, OFF_VIEW),
    "POST /cloud-link": () => jsonRes(200, { ok: true, settings: { url: null, enabled: false }, enrollmentCleared: false }),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.saveBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.saveStatus.textContent, "Saved.");
});

/* ------------------------------------------------------------------ */
/* Enroll: POST /cloud-link/enroll.                                    */
/* ------------------------------------------------------------------ */

await check("REQUIRED: 'Get a claim code' posts /cloud-link/enroll and the new code appears in the state text", async () => {
  const { doc } = mountedPage();
  const enrollBody = { ok: true, state: "waiting_for_claim", deviceId: "PLPG3LDH", claimCode: "WXYZ-1234-7", codeExpiresUtc: "2026-09-29T00:00:00.000Z", codeExpired: false, lastCheckinUtc: null, lastOutcome: null };
  const { fetchFn, calls } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, OFF_VIEW),
    "POST /cloud-link/enroll": () => jsonRes(200, enrollBody),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.enrollBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.stateText.textContent.includes("WXYZ-1234-7"), true, page.dom.stateText.textContent);
  eq(calls.some((c) => c.url === "/cloud-link/enroll" && c.init && c.init.method === "POST"), true);
});

await check("REQUIRED: enrolling while off (409 cloud_off) shows the server's own message and changes nothing on screen", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, OFF_VIEW),
    // agent/cloud-link.mjs's own refusal text for this case, verbatim.
    "POST /cloud-link/enroll": () => jsonRes(409, { ok: false, code: "cloud_off", message: "turn the cloud on, with an address, before requesting a claim code" }),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.enrollBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.enrollStatus.textContent, "turn the cloud on, with an address, before requesting a claim code");
  eq(page.dom.stateText.textContent, "Off", "unchanged");
  eq(page.dom.enrollStatus.textContent.length > 0, true, "some plain message shown");
});

await check("enrolling never overwrites the address/switch the form is showing -- the enroll response carries no settings of its own", async () => {
  const { doc } = mountedPage();
  const { fetchFn } = makeFetchFrom({
    "GET /cloud-link": () => jsonRes(200, WAITING_VIEW),
    "POST /cloud-link/enroll": () => jsonRes(200, { ok: true, state: "waiting_for_claim", deviceId: "PLPG3LDH", claimCode: "NEWC-ODE1-2", codeExpiresUtc: "2026-10-01T00:00:00.000Z", codeExpired: false, lastCheckinUtc: null, lastOutcome: null }),
  });
  const page = client.startCloudPage({ doc, fetchFn });
  await page.ready;
  page.dom.enrollBtn.fire("click");
  await new Promise((r) => setTimeout(r, 20));
  eq(page.dom.urlInput.value, "https://cloud.example.com", "unchanged by the enroll response");
  eq(page.dom.enabledBox.checked, true, "unchanged by the enroll response");
  eq(page.dom.stateText.textContent.includes("NEWC-ODE1-2"), true, page.dom.stateText.textContent);
});

/* ------------------------------------------------------------------ */
/* No innerHTML anywhere in this client.                               */
/* ------------------------------------------------------------------ */

check("cloud-client.mjs never uses innerHTML", async () => {
  const src = await readFile(join(root, "agent/ui/cloud-client.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  eq(code.includes("innerHTML"), false);
});

/* ------------------------------------------------------------------ */
/* THE FEARED ONE: the browser starts this itself.                     */
/* ------------------------------------------------------------------ */

await check("THE FEARED ONE: in a browser the page STARTS ITSELF -- loading cloud-client.mjs with the real page in the DOM fetches /cloud-link with no harness calling it", () => {
  const clientUrl = pathToFileURL(join(root, "agent/ui/cloud-client.mjs")).href;
  const code = `
    const handler = {
      get(t, k) {
        if (k === Symbol.toPrimitive) return () => "";
        if (k === "then") return undefined;
        if (k === "value" || k === "textContent") return "";
        if (k === "length") return 0;
        return fake;
      },
      apply() { return fake; },
      set() { return true; },
    };
    const fake = new Proxy(function () {}, handler);
    const calls = [];
    globalThis.document = {
      getElementById: (id) => (id === "cloudSectionRoot" ? fake : null),
      createElement: () => fake, createElementNS: () => fake,
      createTextNode: () => fake, querySelector: () => fake, querySelectorAll: () => [],
      addEventListener() {}, body: fake, documentElement: fake,
    };
    globalThis.window = { location: { assign() {} }, addEventListener() {} };
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, settings: { url: null, enabled: false }, state: "off", deviceId: null, claimCode: null, codeExpiresUtc: null, codeExpired: false, lastCheckinUtc: null, lastOutcome: null }) });
    };
    await import(${JSON.stringify(clientUrl)} + "?boot");
    await new Promise((r) => setTimeout(r, 150));
    console.log(JSON.stringify(calls));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", cwd: root, timeout: 20_000 });
  eq(r.status, 0, `the child ran (${(r.stderr || "").slice(0, 400)})`);
  const lines = (r.stdout || "").trim().split(/\r?\n/);
  const calls = JSON.parse(lines[lines.length - 1] || "[]");
  eq(calls.includes("/cloud-link"), true, `it asked for /cloud-link on its own: ${JSON.stringify(calls)}`);
});

/* ------------------------------------------------------------------ */
/* system.html: the mount point and the client's own script tag.       */
/* ------------------------------------------------------------------ */

await check("system.html mounts #cloudSectionRoot below #siteSectionRoot and loads cloud-client.js", async () => {
  const html = await readFile(join(root, "agent/ui/system.html"), "utf8");
  const siteRootAt = html.indexOf('id="siteSectionRoot"');
  const cloudRootAt = html.indexOf('id="cloudSectionRoot"');
  eq(siteRootAt >= 0, true, "site mount present");
  eq(cloudRootAt >= 0, true, "cloud mount present");
  eq(cloudRootAt > siteRootAt, true, "the Cloud mount comes below the Site mount");
  eq(html.includes('src="/ui/cloud-client.js"'), true, "the page loads the client");
});

report("cloud page");
