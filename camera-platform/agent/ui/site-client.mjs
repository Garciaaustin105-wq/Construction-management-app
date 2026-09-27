// agent/ui/site-client.mjs
//
// The "Site" section on the System page (agent/ui/system.html),
// SITE-SETTINGS-SPEC.md sections 1-2: display name, time zone, site type
// with presets, per-site feature switches, version and license (read-only),
// and the list of cameras whose own AI schedule is saved in a different zone
// than the site's effective one.
//
// Deliberately its OWN file, not folded into system-client.mjs (one owner
// per file, AGENTS.md build rule 3): system-client.mjs already owns the
// /health poll and the History charts; this file owns only the installer's
// Site section, and is wired to system.html by its own <script> tag, exactly
// the way camera-ai-client.mjs sits beside cameras-client.mjs.
//
// Same discipline as every other *-client.mjs on this NVR: every dependency
// (the document, fetch, the clock) arrives through `opts`, never read off a
// bare global inside an exported function, so a harness can drive this
// without a browser. Nothing here ever sets innerHTML -- every node is built
// with createElement, and every piece of untrusted text (a camera's own
// name) is set with .textContent.
//
// THE FEARED FAILURES this file is written against:
// - a store account (no system.manage) seeing an installer-only section that
//   quietly does nothing when they press Save: GET /site-settings answers
//   403 for them, and this file removes the whole section rather than show a
//   form that can never work (rule 10: refuse rather than guess).
// - a preset silently reapplying and this page never SAYING so: every save
//   that actually changed siteType shows which switches the preset touched,
//   once, right after that save -- never a stamp that shows up again on a
//   later save that did not change the type (contracts/siteSettings.ts's own
//   applyPreset already refuses to touch anything then; this file's note
//   just has to agree).
// - "no custom schedule" being confused with "in another zone": a camera
//   with schedule === null (always open, no zone of its own) is never listed
//   as being in another zone -- only a camera with an actual saved schedule
//   whose timeZone differs from the site's effective one.
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): see the bottom of
//   this file.

const NOT_MEASURED = "not measured";

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

// Mirrored from contracts/siteSettings.ts -- that file compiles to CommonJS
// (dist/tsconfig's "module": "NodeNext"), so it cannot be imported by a
// browser the way dist/gridLayout.mjs can. This is the contract's own source
// of truth; harness/sitePage.harness.mjs checks this copy still matches it.
export const MAX_DISPLAY_NAME_LENGTH = 80;

// Mirrored from contracts/siteSettings.ts's own appearance-match constants
// (APPEARANCE-OF-DAY-SPEC.md, MANAGER-RULES-SPEC.md build 3: "50-99, default
// 80"). Same mirroring discipline as MAX_DISPLAY_NAME_LENGTH above --
// harness/sitePage.harness.mjs checks these three still match the contract.
export const MIN_APPEARANCE_MATCH_PERCENT = 50;
export const MAX_APPEARANCE_MATCH_PERCENT = 99;
export const DEFAULT_APPEARANCE_MATCH_PERCENT = 80;

// The spec's own "Known limits (say them on the page)" (APPEARANCE-OF-DAY-
// SPEC.md): shown verbatim under the match-threshold field, never softened --
// an installer turning this switch on needs to know what it cannot do before
// they rely on it, the same "report measurements, not verdicts" discipline
// (AGENTS.md build rule 11) applied to a feature's own limits.
export const APPEARANCE_LIMITS_TEXT =
  "Clothing-colour matching is weak across cameras with very different lighting, "
  + "and useless under uniforms. It is uncalibrated until you record test walks.";

const REASON_TEXT = {
  bad_display_name: `must be plain text, at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
  bad_time_zone: "is not a recognised time zone",
  bad_site_type: "is not one of the known site types",
  not_an_object: "must be an object",
  unknown_feature_key: "is not a feature this recorder knows about",
  bad_feature_flag: "must be on or off",
  bad_appearance_match_percent: `must be a number from ${MIN_APPEARANCE_MATCH_PERCENT} to ${MAX_APPEARANCE_MATCH_PERCENT}`,
};

/** Plain text for a FieldProblem.reason -- never the raw code, on a page an
 *  installer (not a developer) reads. */
export function describeSiteReason(reason) {
  return REASON_TEXT[reason] || String(reason);
}

const SITE_TYPE_LABELS = {
  retail: "Retail",
  storage: "Storage",
  carwash: "Car wash",
  home: "Home",
  other: "Other",
};

export function siteTypeLabel(siteType) {
  return SITE_TYPE_LABELS[siteType] || String(siteType);
}

const FEATURE_LABELS = {
  activity: "Activity",
  managerRules: "Manager rules",
  // "we don't need facial rec" (owner's own words, memory manager-ai-rules) --
  // the label itself says so, every place this switch appears, not just the
  // limits text below it.
  appearanceOfDay: "Appearance of the day (no face)",
};

export function featureLabel(key) {
  return FEATURE_LABELS[key] || key;
}

/**
 * The cameras whose OWN saved AI schedule names a time zone that is not the
 * site's current effective one -- "the page lists any camera whose schedule
 * is in a different zone" (SITE-SETTINGS-SPEC.md). `aiCameras` is GET
 * /camera-ai-settings' own `cameras` map (cameraId -> CameraAiSettings);
 * `nameOf(cameraId)` returns a display name, or the id itself when none is
 * known. A camera with `schedule: null` ("always", no zone of its own) is
 * never listed -- there is no zone to disagree with the site's.
 */
export function camerasInAnotherZone(aiCameras, effectiveZone, nameOf) {
  const out = [];
  if (!aiCameras || typeof aiCameras !== "object") return out;
  if (typeof effectiveZone !== "string" || effectiveZone === "") return out;
  const ids = Object.keys(aiCameras).sort();
  for (const cameraId of ids) {
    const settings = aiCameras[cameraId];
    const schedule = settings && typeof settings === "object" ? settings.schedule : null;
    if (!schedule || typeof schedule !== "object") continue;
    if (typeof schedule.timeZone !== "string" || schedule.timeZone === "" || schedule.timeZone === effectiveZone) continue;
    out.push({ cameraId, name: typeof nameOf === "function" ? nameOf(cameraId) : cameraId, zone: schedule.timeZone });
  }
  return out;
}

/** Feature keys whose value differs between two feature maps -- used to say
 *  what a just-applied preset actually changed, never to show old/new values
 *  (the same "never a value, only which field" discipline diffSiteSettings
 *  itself keeps). */
export function changedFeatureKeys(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of [...keys].sort()) {
    if (Boolean((before || {})[key]) !== Boolean((after || {})[key])) out.push(key);
  }
  return out;
}

function formatInstalledAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

/* ── the section's own DOM ────────────────────────────────────────────── */

/**
 * Builds the whole Site section's DOM once. `opts.timeZones` is the list of
 * IANA names for the searchable time-zone field (Intl.supportedValuesOf
 * when the browser has it; empty when it does not -- the field still takes
 * free text, it just has nothing to suggest).
 */
export function buildSiteSection(doc, opts) {
  const timeZones = Array.isArray(opts && opts.timeZones) ? opts.timeZones : [];

  const nameInput = el(doc, "input", { type: "text", id: "siteDisplayName", maxlength: String(MAX_DISPLAY_NAME_LENGTH), autocomplete: "off" });

  const tzInput = el(doc, "input", { type: "text", id: "siteTimeZone", list: "siteTimeZoneList", autocomplete: "off", placeholder: "System zone" });
  const tzList = el(doc, "datalist", { id: "siteTimeZoneList" }, timeZones.map((z) => el(doc, "option", { value: z })));
  const tzNote = el(doc, "p", { class: "dim", id: "siteTimeZoneNote" });

  const typeSelect = el(doc, "select", { id: "siteType" }, [
    el(doc, "option", { value: "", text: "(not set)" }),
    ...Object.keys(SITE_TYPE_LABELS).map((t) => el(doc, "option", { value: t, text: SITE_TYPE_LABELS[t] })),
  ]);
  const typeNote = el(doc, "p", { class: "dim", id: "siteTypeNote", text: "Choosing a type sets its feature switches once. Change any of them afterwards and they stay changed." });
  const presetNote = el(doc, "p", { class: "good", id: "sitePresetNote", role: "status" });

  const featuresList = el(doc, "div", { id: "siteFeatures" }, []);

  // Appearance of the day's own match threshold (APPEARANCE-OF-DAY-SPEC.md:
  // "a per-site setting, default 80%") -- its own field, not a feature
  // switch, so it lives beside siteFeatures rather than inside
  // renderFeatures' loop over FEATURE_REGISTRY. Always visible (even with the
  // switch off) so turning appearanceOfDay on and setting a threshold can
  // happen in the same save, without a round trip.
  const appearanceMatchInput = el(doc, "input", {
    type: "number", id: "siteAppearanceMatchPercent",
    min: String(MIN_APPEARANCE_MATCH_PERCENT), max: String(MAX_APPEARANCE_MATCH_PERCENT), step: "1",
  });
  const appearanceLimitsText = el(doc, "p", { class: "dim", id: "siteAppearanceLimits", text: APPEARANCE_LIMITS_TEXT });
  const appearanceBlock = el(doc, "div", { class: "siteAppearanceBlock" }, [
    el(doc, "div", { class: "row" }, [el(doc, "label", { text: "Match threshold (%)" }, []), appearanceMatchInput]),
    appearanceLimitsText,
  ]);

  const zonesList = el(doc, "div", { id: "siteZoneMismatches" }, []);

  const versionBlock = el(doc, "div", { id: "siteVersionBlock" }, []);

  const saveErrors = el(doc, "div", { class: "error", id: "siteSettingsErrors", role: "alert" }, []);
  const saveBtn = el(doc, "button", { type: "button", id: "siteSettingsSave", text: "Save" });
  const saveStatus = el(doc, "span", { class: "dim", id: "siteSettingsStatus" });

  const notice = el(doc, "p", { class: "error", id: "siteSectionNotice", hidden: true });

  const section = el(doc, "section", { id: "siteSection", class: "panel" }, [
    el(doc, "h2", { text: "Site" }),
    notice,
    el(doc, "div", { class: "row" }, [el(doc, "label", { text: "Display name" }, []), nameInput]),
    el(doc, "div", { class: "row" }, [el(doc, "label", { text: "Time zone" }, []), tzInput, tzList]),
    tzNote,
    el(doc, "div", { class: "row" }, [el(doc, "label", { text: "Site type" }, []), typeSelect]),
    typeNote,
    presetNote,
    el(doc, "h3", { text: "Features" }),
    featuresList,
    appearanceBlock,
    saveErrors,
    el(doc, "div", { class: "row" }, [saveBtn, saveStatus]),
    el(doc, "h3", { text: "Cameras in another time zone" }),
    zonesList,
    el(doc, "h3", { text: "Version and license" }),
    versionBlock,
  ]);

  return {
    root: section,
    nameInput, tzInput, tzNote, typeSelect, typeNote, presetNote, featuresList,
    appearanceMatchInput, appearanceLimitsText,
    zonesList, versionBlock, saveErrors, saveBtn, saveStatus, notice,
  };
}

function renderFeatures(doc, dom, registry, features, disabled) {
  clearChildren(dom.featuresList);
  const list = Array.isArray(registry) ? registry : [];
  if (list.length === 0) {
    dom.featuresList.append(el(doc, "p", { class: "dim", text: "No switchable features on this build." }));
    return;
  }
  for (const f of list) {
    const box = el(doc, "input", { type: "checkbox", id: `siteFeature_${f.key}` });
    box.checked = Boolean((features || {})[f.key]);
    box.disabled = Boolean(disabled);
    const row = el(doc, "label", { class: "row siteFeatureRow" }, [
      box, el(doc, "span", { text: featureLabel(f.key) }),
    ]);
    dom.featuresList.append(row);
    dom._featureBoxes = dom._featureBoxes || {};
    dom._featureBoxes[f.key] = box;
  }
}

function renderZoneMismatches(doc, dom, cameras) {
  clearChildren(dom.zonesList);
  if (cameras.length === 0) {
    dom.zonesList.append(el(doc, "p", { class: "dim", text: "Every camera's own schedule matches the site's zone." }));
    return;
  }
  const list = el(doc, "ul", {}, []);
  for (const c of cameras) {
    // c.name is untrusted (an installer-typed camera name): .textContent only.
    list.append(el(doc, "li", { text: `${c.name} — schedule saved in ${c.zone}` }));
  }
  dom.zonesList.append(list);
}

function renderVersion(doc, dom, data) {
  clearChildren(dom.versionBlock);
  const rows = [];
  if (data.version) {
    rows.push(el(doc, "p", { text: `Version ${data.version.version} — installed at ${formatInstalledAt(data.version.installedAtUtc)}` }));
  } else {
    rows.push(el(doc, "p", { class: "warn", text: data.versionProblem || NOT_MEASURED }));
  }
  if (Array.isArray(data.trustedKeyIds) && data.trustedKeyIds.length > 0) {
    rows.push(el(doc, "p", { text: `Trusted release keys: ${data.trustedKeyIds.join(", ")}` }));
  } else {
    rows.push(el(doc, "p", { class: "dim", text: data.trustedKeysProblem || "No trusted release keys configured." }));
  }
  rows.push(el(doc, "p", { class: "dim", text: data.license || NOT_MEASURED }));
  dom.versionBlock.append(...rows);
}

/* ── page driver ──────────────────────────────────────────────────────── */

/**
 * Wires the Site section: loads GET /site-settings and GET /camera-ai-
 * settings + /camera-settings (for the zone-mismatch list), fills the form,
 * and wires Save to POST /site-settings.
 *
 * A store account (no system.manage) gets 403 on GET /site-settings: the
 * whole section is removed rather than left as a form that can never save
 * (rule 10 -- refuse rather than guess at a partial page).
 */
export function startSitePage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const rootId = opts.rootId || "siteSectionRoot";
  const root = byId(doc, rootId);
  if (!root) return { ready: Promise.resolve() };

  let timeZones = [];
  if (Array.isArray(opts.timeZones)) {
    timeZones = opts.timeZones;
  } else if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") {
    try { timeZones = Intl.supportedValuesOf("timeZone"); } catch { timeZones = []; }
  }

  const dom = buildSiteSection(doc, { timeZones });
  root.append(dom.root);

  let registry = [];
  let siteType = null;
  let systemZone = "UTC";
  let effectiveZone = "UTC";

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

  function applySettings(settings, sysZone, effZone) {
    siteType = settings.siteType;
    systemZone = sysZone;
    effectiveZone = effZone;
    dom.nameInput.value = settings.displayName || "";
    dom.tzInput.value = settings.timeZone || "";
    dom.tzNote.textContent = settings.timeZone
      ? `Effective zone: ${effZone}`
      : `Blank uses the recorder's own zone: ${sysZone}`;
    dom.typeSelect.value = settings.siteType || "";
    renderFeatures(doc, dom, registry, settings.features, false);
    // "A blank is not a zero" (build rule 5): a site that never saved this
    // reads settings.appearanceMatchPercent already defaulted to 80 by
    // checkSiteSettings/defaultSiteSettings server-side -- this field is
    // never left blank or zeroed here either.
    dom.appearanceMatchInput.value = String(
      typeof settings.appearanceMatchPercent === "number" ? settings.appearanceMatchPercent : DEFAULT_APPEARANCE_MATCH_PERCENT,
    );
  }

  async function loadZoneMismatches() {
    try {
      const [aiRes, camRes] = await Promise.all([
        fetchFn("/camera-ai-settings", { credentials: "same-origin" }),
        fetchFn("/camera-settings", { credentials: "same-origin" }),
      ]);
      const aiData = await aiRes.json().catch(() => null);
      const camData = await camRes.json().catch(() => null);
      const names = {};
      for (const c of Array.isArray(camData && camData.cameras) ? camData.cameras : []) {
        if (c && typeof c.cameraId === "string") names[c.cameraId] = (typeof c.name === "string" && c.name) || c.cameraId;
      }
      const zone = (aiData && typeof aiData.timeZone === "string") ? aiData.timeZone : effectiveZone;
      const mismatches = camerasInAnotherZone(aiData && aiData.cameras, zone, (id) => names[id] || id);
      renderZoneMismatches(doc, dom, mismatches);
    } catch (err) {
      log("error", "site section: could not read camera AI schedules", { message: err && err.message });
      renderZoneMismatches(doc, dom, []);
    }
  }

  async function load() {
    let res;
    try {
      res = await fetchFn("/site-settings", { credentials: "same-origin" });
    } catch (err) {
      hideEverything("Could not reach the recorder.");
      return;
    }
    if (res.status === 403) {
      // Not an installer: this account cannot see or change these settings.
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
      hideEverything((data && data.message) || "Could not load site settings.");
      return;
    }
    registry = Array.isArray(data.featureRegistry) ? data.featureRegistry : [];
    applySettings(data.settings, data.systemTimeZone, data.effectiveTimeZone);
    showNotice(data.problem || null);
    renderVersion(doc, dom, data);
    await loadZoneMismatches();
  }

  function readFeaturesFromForm() {
    const out = {};
    for (const f of registry) {
      const box = dom._featureBoxes && dom._featureBoxes[f.key];
      out[f.key] = box ? Boolean(box.checked) : f.registryDefault;
    }
    return out;
  }

  async function save() {
    dom.saveBtn.disabled = true;
    dom.saveStatus.textContent = "Saving…";
    clearChildren(dom.saveErrors);
    dom.presetNote.textContent = "";
    const beforeFeatures = readFeaturesFromForm();
    const beforeType = siteType;
    // The match threshold is a full-replace field (agent/site-settings.mjs's
    // own POST /site-settings: "not a preset-driven switch and not
    // openHours' own separate route, so it always takes whatever this save
    // submitted") -- sent on EVERY save, never omitted, or an installer
    // saving just their display name would silently reset it back to 80
    // (checkSiteSettings defaults an absent field, it does not preserve one).
    const matchPercentRaw = Number(dom.appearanceMatchInput.value);
    const body = {
      displayName: dom.nameInput.value,
      timeZone: dom.tzInput.value.trim() === "" ? null : dom.tzInput.value.trim(),
      siteType: dom.typeSelect.value === "" ? null : dom.typeSelect.value,
      features: beforeFeatures,
      appearanceMatchPercent: Number.isFinite(matchPercentRaw) ? matchPercentRaw : DEFAULT_APPEARANCE_MATCH_PERCENT,
    };
    try {
      const res = await fetchFn("/site-settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (data && Array.isArray(data.errors)) {
          const list = el(doc, "ul", {}, data.errors.map((e) => el(doc, "li", { text: `${e.field}: ${describeSiteReason(e.reason)}` })));
          dom.saveErrors.append(el(doc, "p", { text: "These settings could not be saved:" }), list);
        } else {
          dom.saveStatus.textContent = (data && data.message) || "Something went wrong.";
        }
        return;
      }
      dom.saveStatus.textContent = "Saved.";
      applySettings(data.settings, systemZone, data.settings.timeZone || systemZone);
      if (body.siteType !== beforeType) {
        const changed = changedFeatureKeys(beforeFeatures, data.settings.features);
        dom.presetNote.textContent = changed.length > 0
          ? `Site type set to ${siteTypeLabel(body.siteType || "")}. Turned on: ${changed.filter((k) => data.settings.features[k]).map(featureLabel).join(", ") || "none"}. Turned off: ${changed.filter((k) => !data.settings.features[k]).map(featureLabel).join(", ") || "none"}.`
          : (body.siteType ? `Site type set to ${siteTypeLabel(body.siteType)}. No switches changed.` : "");
      }
      await loadZoneMismatches();
    } catch (err) {
      log("error", "site settings save failed", { message: err && err.message });
      dom.saveStatus.textContent = "Could not reach the recorder.";
    } finally {
      dom.saveBtn.disabled = false;
    }
  }
  dom.saveBtn.addEventListener("click", () => { void save(); });

  const ready = load();
  return { ready, reload: load, dom };
}

// Browser bootstrap. Runs only when the real System page has this section's
// mount point in the DOM; a harness importing this module for its pure
// exports (describeSiteReason, camerasInAnotherZone, ...) has no side
// effects. Copies camera-page-bootstrap-lesson (agent bus, 2026-09-26): a
// client with no browser bootstrap passes every harness check that drives
// its exported functions directly while the real page never fetches
// anything -- see harness/sitePage.harness.mjs's own copy of
// activityPage.harness.mjs's THE FEARED ONE check.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("siteSectionRoot")) {
  startSitePage({
    doc: document,
    fetchFn: function (url, init) { return fetch(url, init); },
    navigate: function (url) { window.location.assign(url); },
    log: () => {},
  });
}
