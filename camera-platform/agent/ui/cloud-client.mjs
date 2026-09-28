// agent/ui/cloud-client.mjs
//
// The "Cloud" section on the System page (agent/ui/system.html),
// CLOUD-LINK-SPEC.md section D: the cloud address, the On/Off switch, the
// link's own state in words, the last check-in, the device id, and "Get a
// claim code". Installer only (system.manage) -- same gate as the Site
// section, GET /cloud-link answers 403 for anyone else.
//
// Deliberately its OWN file, not folded into site-client.mjs or
// system-client.mjs (one owner per file, AGENTS.md build rule 3):
// system-client.mjs owns /health and History, site-client.mjs owns the Site
// section, and this file owns only the Cloud section -- wired to system.html
// by its own <script> tag, exactly the way site-client.mjs sits beside
// system-client.mjs.
//
// Same discipline as every other *-client.mjs on this NVR: every dependency
// (the document, fetch, the clock) arrives through `opts`, never read off a
// bare global inside an exported function, so a harness can drive this
// without a browser. Nothing here ever sets innerHTML -- every node is built
// with createElement, and every piece of untrusted text (a claim code, an
// outcome string) is set with .textContent.
//
// THE FEARED FAILURES this file is written against:
// - a store account (no system.manage) seeing an installer-only section that
//   quietly does nothing when they press Save: GET /cloud-link answers 403
//   for them, and this file removes the whole section rather than show a
//   form that can never work (rule 10: refuse rather than guess).
// - a claim code still shown once the box is claimed, or once its own code
//   has expired: this file never invents or caches a claim code of its own
//   -- every render takes the server's `claimCode`/`codeExpired` exactly as
//   given (the contract already nulls `claimCode` once claimed or expired;
//   this file just has to not paper over that with a stale DOM value from a
//   previous render).
// - "never checked in" rendering as some default time or a blank field
//   (build rule 5 -- a blank is not a zero): `lastCheckinUtc: null` reads as
//   the word "never", not an empty string or "Invalid Date".
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): see the bottom of
//   this file.

function byId(doc, id) {
  return typeof doc.getElementById === "function" ? doc.getElementById(id) : null;
}

function clearChildren(el) {
  if (!el) return;
  if (typeof el.replaceChildren === "function") el.replaceChildren();
  else while (el.firstChild) el.removeChild(el.firstChild);
}

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
  for (const kid of kids || []) {
    if (kid !== null && kid !== undefined) node.append(kid);
  }
  return node;
}

/* ── pure helpers (no document, no fetch) ─────────────────────────────── */

const REASON_TEXT = {
  not_an_object: "must be a valid settings object",
  bad_url: "must be a valid https:// address -- http:// is refused, never upgraded, and it must actually parse",
  url_has_credentials: "must not carry a username or password (a user:pass@ part)",
  bad_enabled: "must be on or off",
};

/** Plain text for a checkCloudSettings refusal reason -- never the raw code,
 *  on a page an installer (not a developer) reads. Mirrors site-client.mjs's
 *  own describeSiteReason for the same purpose. */
export function describeCloudLinkReason(reason) {
  return REASON_TEXT[reason] || String(reason);
}

/** Whether `code` is one of checkCloudSettings' own four refusal reasons --
 *  agent/cloud-link.mjs's POST /cloud-link puts that reason in the
 *  response's `code` field (its `message` is a fixed, generic sentence for
 *  every one of them: "these cloud settings could not be saved"), so only a
 *  code in THIS set is worth translating through describeCloudLinkReason.
 *  Any other code (e.g. "cloud_settings_unreadable", a 409) already carries
 *  its own specific, human-readable `message` from the server -- showing
 *  that instead is more useful than "cloud_settings_unreadable" verbatim. */
function isKnownSettingsReason(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(REASON_TEXT, code);
}

function formatUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

const STATE_LABELS = { off: "Off", not_enrolled: "Not enrolled yet", claimed: "Claimed" };
const STATE_CLASS = { off: "dim", not_enrolled: "warn", waiting_for_claim: "warn", claimed: "good" };

/** The css class the state line takes -- "dim" for off, "warn" while
 *  something is waiting on a human, "good" once claimed. Never thrown on an
 *  unrecognised state; falls back to "dim" rather than crash the page. */
export function cloudStateClass(state) {
  return STATE_CLASS[state] || "dim";
}

/**
 * The state, in words, exactly as CLOUD-LINK-SPEC.md section D describes it:
 * "Off", "Not enrolled yet", "Waiting for the installer to claim it -- code
 * XXXX-XXXX-C, expires ...", "Claimed". `view` is GET/POST /cloud-link's own
 * response (a CloudStatusView plus `settings`) -- this function reads only
 * `state`, `claimCode`, `codeExpiresUtc` and `codeExpired`, and trusts them
 * exactly as given (build rule 11: report measurements, do not invent a
 * verdict of its own).
 *
 * An expired code is its own sentence, not a silently-hidden one (the
 * contract's own "never silently" rule for codeExpired) and not the same
 * text as a still-live one.
 */
export function cloudStateText(view) {
  const state = view && typeof view === "object" ? view.state : "off";
  if (state === "waiting_for_claim") {
    if (view.codeExpired) {
      return typeof view.codeExpiresUtc === "string" && view.codeExpiresUtc
        ? `Waiting for the installer to claim it — the code expired at ${formatUtc(view.codeExpiresUtc)}. Get a new one.`
        : "Waiting for the installer to claim it — the code expired. Get a new one.";
    }
    const code = typeof view.claimCode === "string" && view.claimCode ? view.claimCode : "……";
    const expires = typeof view.codeExpiresUtc === "string" && view.codeExpiresUtc ? formatUtc(view.codeExpiresUtc) : "unknown";
    return `Waiting for the installer to claim it — code ${code}, expires ${expires}`;
  }
  return STATE_LABELS[state] || String(state);
}

/** "Last check-in ... -- outcome", or "Last check-in: never" when
 *  `lastCheckinUtc` is null -- a box that has never checked in is never
 *  shown a guessed or blank time (build rule 5). */
export function checkinText(view) {
  const at = view && typeof view === "object" ? view.lastCheckinUtc : null;
  if (typeof at !== "string" || at === "") return "Last check-in: never";
  const outcome = view && typeof view.lastOutcome === "string" && view.lastOutcome ? view.lastOutcome : "unknown";
  return `Last check-in: ${formatUtc(at)} — ${outcome}`;
}

/** "Device id: ..." once one exists, whatever the current state (an
 *  installer who switched the cloud back off can still see which device
 *  this box last enrolled as, cloudStatusView's own doc comment) -- "not
 *  assigned yet" rather than blank when there is none. */
export function deviceIdText(view) {
  const id = view && typeof view === "object" ? view.deviceId : null;
  return typeof id === "string" && id.length > 0 ? `Device id: ${id}` : "Device id: not assigned yet";
}

/* ── the section's own DOM ────────────────────────────────────────────── */

/** Builds the whole Cloud section's DOM once. */
export function buildCloudSection(doc) {
  const stateText = el(doc, "p", { id: "cloudState" });
  const checkinLine = el(doc, "p", { class: "dim", id: "cloudCheckin" });
  const deviceLine = el(doc, "p", { class: "dim", id: "cloudDeviceId" });

  const urlInput = el(doc, "input", { type: "text", id: "cloudUrl", autocomplete: "off", placeholder: "https://your-cloud.example.com" });
  const enabledBox = el(doc, "input", { type: "checkbox", id: "cloudEnabled" });

  const saveErrors = el(doc, "div", { class: "error", id: "cloudSaveErrors", role: "alert" }, []);
  const saveBtn = el(doc, "button", { type: "button", id: "cloudSaveBtn", text: "Save" });
  const saveStatus = el(doc, "span", { class: "dim", id: "cloudSaveStatus" });

  const enrollBtn = el(doc, "button", { type: "button", id: "cloudEnrollBtn", text: "Get a claim code" });
  const enrollStatus = el(doc, "span", { class: "dim", id: "cloudEnrollStatus" });

  const notice = el(doc, "p", { class: "error", id: "cloudSectionNotice", hidden: true });

  const section = el(doc, "section", { id: "cloudSection", class: "panel" }, [
    el(doc, "h2", { text: "Cloud" }),
    notice,
    stateText,
    checkinLine,
    deviceLine,
    el(doc, "div", { class: "row" }, [el(doc, "label", { text: "Cloud address" }, []), urlInput]),
    el(doc, "div", { class: "row" }, [el(doc, "label", { text: "On" }, []), enabledBox]),
    saveErrors,
    el(doc, "div", { class: "row" }, [saveBtn, saveStatus]),
    el(doc, "div", { class: "row" }, [enrollBtn, enrollStatus]),
  ]);

  return {
    root: section,
    stateText, checkinLine, deviceLine, urlInput, enabledBox,
    saveErrors, saveBtn, saveStatus, enrollBtn, enrollStatus, notice,
  };
}

/* ── page driver ──────────────────────────────────────────────────────── */

/**
 * Wires the Cloud section: loads GET /cloud-link, fills the form, and wires
 * Save to POST /cloud-link and "Get a claim code" to POST /cloud-link/enroll.
 *
 * A store account (no system.manage) gets 403 on GET /cloud-link: the whole
 * section is removed rather than left as a form that can never save (rule
 * 10 -- refuse rather than guess at a partial page), same as site-client.mjs.
 */
export function startCloudPage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const rootId = opts.rootId || "cloudSectionRoot";
  const root = byId(doc, rootId);
  if (!root) return { ready: Promise.resolve() };

  const dom = buildCloudSection(doc);
  root.append(dom.root);

  function showNotice(text) {
    if (!text) { dom.notice.hidden = true; dom.notice.textContent = ""; return; }
    dom.notice.hidden = false;
    dom.notice.textContent = text;
  }

  function hideEverything(text) {
    clearChildren(root);
    showNotice(text);
    root.append(dom.notice);
  }

  /** Renders the whole section from one CloudStatusView-plus-settings
   *  payload (GET or POST /cloud-link's own shape, or an enroll response
   *  merged with the form's own current address/switch -- enroll never
   *  changes those). Always a full re-render, never a patch: a caller that
   *  passed a view with `claimCode: null` clears any code this section was
   *  showing a moment ago, rather than leave a stale one on screen. */
  function applyView(data) {
    const settings = (data && typeof data.settings === "object" && data.settings !== null)
      ? data.settings
      : { url: dom.urlInput.value, enabled: dom.enabledBox.checked };
    dom.urlInput.value = typeof settings.url === "string" ? settings.url : "";
    dom.enabledBox.checked = Boolean(settings.enabled);
    dom.stateText.textContent = cloudStateText(data);
    dom.stateText.className = cloudStateClass(data && data.state);
    dom.checkinLine.textContent = checkinText(data);
    dom.deviceLine.textContent = deviceIdText(data);
  }

  async function load() {
    let res;
    try {
      res = await fetchFn("/cloud-link", { credentials: "same-origin" });
    } catch (err) {
      hideEverything("Could not reach the recorder.");
      return;
    }
    if (res.status === 403) {
      // Not an installer: this account cannot see or change the cloud link.
      hideEverything(null);
      root.hidden = true;
      return;
    }
    if (res.status === 401) {
      if (typeof opts.navigate === "function") opts.navigate("/login?next=%2Fsystem");
      return;
    }
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false) {
      hideEverything((data && data.message) || "Could not load the cloud link.");
      return;
    }
    showNotice(data.problem || null);
    applyView(data);
  }

  async function save() {
    dom.saveBtn.disabled = true;
    dom.saveStatus.textContent = "Saving…";
    clearChildren(dom.saveErrors);
    dom.enrollStatus.textContent = "";
    const typed = dom.urlInput.value.trim();
    const body = { url: typed === "" ? null : typed, enabled: Boolean(dom.enabledBox.checked) };
    try {
      const res = await fetchFn("/cloud-link", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        const code = data && typeof data.code === "string" ? data.code : null;
        dom.saveErrors.append(el(doc, "p", {
          text: isKnownSettingsReason(code)
            ? `Not saved: ${describeCloudLinkReason(code)}`
            : ((data && data.message) || "Something went wrong."),
        }));
        dom.saveStatus.textContent = "";
        return;
      }
      // POST /cloud-link's own success body is only `{ settings,
      // enrollmentCleared }` -- never the state view (agent/cloud-link.mjs),
      // so the state/check-in/device-id lines are refreshed from a real GET
      // rather than guessed at from what just got posted (a URL change can
      // move the state itself, e.g. claimed -> not_enrolled).
      await load();
      // "Changing the URL to a different address clears cloud-enrollment.json
      // ... stated in the response, never silent" (CLOUD-LINK-SPEC.md section
      // B): said here, once, right after the save that actually did it --
      // never a stamp that lingers on a later save that changed nothing.
      dom.saveStatus.textContent = data.enrollmentCleared
        ? "Saved. The old enrolment was cleared -- this box will need a new claim code for the new address."
        : "Saved.";
    } catch (err) {
      log("error", "cloud settings save failed", { message: err && err.message });
      dom.saveStatus.textContent = "Could not reach the recorder.";
    } finally {
      dom.saveBtn.disabled = false;
    }
  }
  dom.saveBtn.addEventListener("click", () => { void save(); });

  async function enroll() {
    dom.enrollBtn.disabled = true;
    dom.enrollStatus.textContent = "Requesting…";
    try {
      const res = await fetchFn("/cloud-link/enroll", { method: "POST", credentials: "same-origin" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        // agent/cloud-link.mjs already writes a specific, human-readable
        // `message` for every refusal here (409 "cloud_off": "turn the cloud
        // on, with an address, before requesting a claim code"; 502
        // "enroll_failed": the real outcome) -- shown as-is, never replaced
        // with a client-guessed sentence.
        dom.enrollStatus.textContent = (data && data.message) || "Something went wrong.";
        return;
      }
      // The enroll response is the new status view only -- it never changes
      // the saved address or switch, so applyView keeps this form's current
      // values for those unless the response itself carries its own
      // `settings` (defensive; the server is the source of truth either way).
      applyView(data);
      dom.enrollStatus.textContent = "";
    } catch (err) {
      log("error", "cloud enroll failed", { message: err && err.message });
      dom.enrollStatus.textContent = "Could not reach the recorder.";
    } finally {
      dom.enrollBtn.disabled = false;
    }
  }
  dom.enrollBtn.addEventListener("click", () => { void enroll(); });

  const ready = load();
  return { ready, reload: load, dom };
}

// Browser bootstrap. Runs only when the real System page has this section's
// mount point in the DOM; a harness importing this module for its pure
// exports (describeCloudLinkReason, cloudStateText, ...) has no side
// effects. Copies camera-page-bootstrap-lesson (agent bus, 2026-09-26): a
// client with no browser bootstrap passes every harness check that drives
// its exported functions directly while the real page never fetches
// anything -- see harness/cloudPage.harness.mjs's own copy of
// activityPage.harness.mjs's THE FEARED ONE check.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("cloudSectionRoot")) {
  startCloudPage({
    doc: document,
    fetchFn: function (url, init) { return fetch(url, init); },
    navigate: function (url) { window.location.assign(url); },
    log: () => {},
  });
}
