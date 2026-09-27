// agent/ui/rules-client.mjs
//
// Client logic for the Rules page (agent/ui/rules.html, MANAGER-RULES-
// SPEC.md section 5): the template picker ("Manager's desk unattended"
// first), the plain-words form, the rule list with on/off switches, the
// camera still with the chosen area outlined, and the open-hours editor
// (with its refusal text) when the site has none set yet.
//
// Same discipline as agent/ui/activity-client.mjs and agent/ui/camera-ai-
// client.mjs: every dependency (the document, fetch, the clock) arrives
// through `opts`, never read off a bare global inside an exported function,
// so a harness can drive this without a browser. Nothing here ever sets
// innerHTML -- every node is built with createElement/createElementNS, and
// every piece of untrusted text (a rule's own name, typed by a manager or
// installer) is set with .textContent, never innerHTML.
//
// Identity-free (MANAGER-RULES-SPEC.md, throughout): this file never asks
// for or renders a person's name anywhere -- a rule's own name is the only
// name any control here ever carries, and the server-side wording
// (ManagerRuleFiring.text, contracts/managerRules.ts) is already
// identity-free by construction.
//
// THE FEARED FAILURES this file is written against:
// - a rule using open_hours/closed_hours saved (or even offered) while the
//   site's openHours is unset: the server refuses this (checkManagerRule,
//   "hours_not_set"), but this page never lets Save look enabled and then
//   fail with jargon -- the exact refusal text from the spec ("set the
//   store's open hours first") is shown up front, and Save is disabled
//   until either `when` is switched to "always" or the hours are set.
// - a stale sentence: the plain-words preview is rebuilt from the SAME
//   draft state Save would send, on every field change, never a separately
//   hand-assembled string that could drift from what actually gets posted.
// - camera-page-bootstrap-lesson (agent bus, 2026-09-26): a client with no
//   browser bootstrap block passes every harness check that drives its
//   exported functions directly while the real page never fetches anything.
//   See the bottom of this file.

const SVG_NS = "http://www.w3.org/2000/svg";

/* ── pure helpers (no document, no fetch) ────────────────────────────── */

/** "a person" / "a vehicle" -- the plain-words form's own first blank. */
export function kindText(kind) {
  return kind === "vehicle" ? "a vehicle" : "a person";
}

/** The condition's own verb phrase, WITH its minutes folded in --
 *  MANAGER-RULES-SPEC.md's own example: "[is missing for more than] [20]
 *  minutes". `draft` is { conditionType, minutes, minMinutes, awayMinutes }.
 *  manager_leaves/manager_returns (APPEARANCE-OF-DAY-SPEC.md) read
 *  manager-MATCH sightings, not occupancy -- their own phrasing says so
 *  ("matching today's manager") rather than reusing the presence-based
 *  wording above, which would misstate what these two actually watch. */
export function verbPhrase(draft) {
  switch (draft.conditionType) {
    case "enters":
      return "enters";
    case "leaves":
      return "leaves";
    case "absent_longer_than":
      return `is missing for more than ${draft.minutes} minutes`;
    case "present_longer_than":
      return `is present for more than ${draft.minutes} minutes`;
    case "away_and_back":
      return `is away and back for at least ${draft.minMinutes} minutes`;
    case "manager_leaves":
      return `matches today's manager and leaves for at least ${draft.awayMinutes} minutes`;
    case "manager_returns":
      return `matches today's manager and returns after being away for at least ${draft.awayMinutes} minutes`;
    default:
      return String(draft.conditionType);
  }
}

const WHEN_TEXT = { open_hours: "open hours", closed_hours: "closed hours", always: "any time" };

/** "AreaName on CameraName", or "the whole CameraName camera" when the rule
 *  has no area (areaId === null, "whole camera" -- MANAGER-RULES-SPEC.md
 *  section 3). Never guesses a name for an id it cannot resolve: an unknown
 *  camera or area reads as its own bare id, exactly like activity-client.mjs's
 *  own cameraNames fallback. */
export function locationText(areaName, cameraName) {
  const cam = cameraName || "(unknown camera)";
  return areaName ? `${areaName} on ${cam}` : `the whole ${cam} camera`;
}

function notifyText(alert, report) {
  if (alert && report) return "alert me and add to the daily report";
  if (alert) return "alert me";
  if (report) return "add to the daily report";
  return "do nothing else";
}

/**
 * The plain-words sentence itself (MANAGER-RULES-SPEC.md section 5):
 * "When [a person] [is missing for more than] [20] minutes from [Manager's
 * desk on Office camera] during [open hours], [alert me] and [add to the
 * daily report]." Built from exactly the fields buildRuleBody below also
 * reads, so the preview can never drift from what Save actually sends.
 */
export function ruleSentence(draft, cameraName, areaName) {
  const when = WHEN_TEXT[draft.when] || draft.when;
  return `When ${kindText(draft.kind)} ${verbPhrase(draft)} from ${locationText(areaName, cameraName)} `
    + `during ${when}, ${notifyText(draft.alert, draft.report)}.`;
}

/** A fresh draft for "start from scratch" (build rule 5: never a blank read
 *  as a zero -- every field here is a real, named default, not an absence). */
export function blankDraft() {
  return {
    id: null, name: "", enabled: true, template: "custom",
    cameraId: "", areaId: null, kind: "person",
    conditionType: "absent_longer_than", minutes: 20, minMinutes: 5, awayMinutes: 5,
    when: "open_hours", alert: true, report: true, cooldownMinutes: 0,
  };
}

/** A draft prefilled from one MANAGER_RULE_TEMPLATES row (GET /rule-
 *  templates) -- "a template only pre-fills a rule; the manager can change
 *  anything" (MANAGER-RULES-SPEC.md section 3). cameraId/areaId are never
 *  guessed by a template: they stay blank/whole-camera until chosen. */
export function draftFromTemplate(def) {
  const d = blankDraft();
  d.template = def.template;
  d.name = def.label;
  d.kind = def.kind;
  d.cameraId = "";
  d.areaId = null;
  d.conditionType = def.condition.type;
  if (def.condition.type === "absent_longer_than" || def.condition.type === "present_longer_than") {
    d.minutes = def.condition.minutes;
  }
  if (def.condition.type === "away_and_back") d.minMinutes = def.condition.minMinutes;
  if (def.condition.type === "manager_leaves" || def.condition.type === "manager_returns") {
    d.awayMinutes = def.condition.awayMinutes;
  }
  d.when = def.when;
  d.alert = def.notify.alert;
  d.report = def.notify.report;
  d.cooldownMinutes = def.notify.cooldownMinutes;
  return d;
}

/** The inverse of buildRuleBody -- a draft to re-edit an existing
 *  ManagerRule (GET /rules), so Edit never has to re-derive what Save would
 *  have sent for it. */
export function draftFromRule(rule) {
  const d = blankDraft();
  d.id = rule.id;
  d.name = rule.name;
  d.enabled = rule.enabled;
  d.template = rule.template;
  d.cameraId = rule.cameraId;
  d.areaId = rule.areaId;
  d.kind = rule.kind;
  d.conditionType = rule.condition.type;
  if (rule.condition.type === "absent_longer_than" || rule.condition.type === "present_longer_than") {
    d.minutes = rule.condition.minutes;
  }
  if (rule.condition.type === "away_and_back") d.minMinutes = rule.condition.minMinutes;
  if (rule.condition.type === "manager_leaves" || rule.condition.type === "manager_returns") {
    d.awayMinutes = rule.condition.awayMinutes;
  }
  d.when = rule.when;
  d.alert = rule.notify.alert;
  d.report = rule.notify.report;
  d.cooldownMinutes = rule.notify.cooldownMinutes;
  return d;
}

/** The POST /rules body from a draft -- the exact shape
 *  contracts/managerRules.ts's checkManagerRule reads (id/createdBy/
 *  updatedUtc/updatedBy are filled in server-side for a new rule, and this
 *  page never guesses them for one). */
export function buildRuleBody(draft) {
  const condition = draft.conditionType === "enters" || draft.conditionType === "leaves"
    ? { type: draft.conditionType }
    : draft.conditionType === "away_and_back"
      ? { type: "away_and_back", minMinutes: draft.minMinutes }
      : draft.conditionType === "manager_leaves" || draft.conditionType === "manager_returns"
        ? { type: draft.conditionType, awayMinutes: draft.awayMinutes }
        : { type: draft.conditionType, minutes: draft.minutes };
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    enabled: draft.enabled,
    template: draft.template,
    cameraId: draft.cameraId,
    areaId: draft.areaId,
    kind: draft.kind,
    condition,
    when: draft.when,
    notify: { alert: draft.alert, report: draft.report, cooldownMinutes: draft.cooldownMinutes },
  };
}

const REASON_TEXT = {
  bad_id: "needs an id", bad_name: "a name is required", bad_enabled: "must be on or off",
  bad_template: "not a known template", bad_camera: "choose a camera",
  bad_area: "choose an area, or whole camera", bad_kind: "must be person or vehicle",
  not_an_object: "must be an object", unknown_field: "has a field this page does not know",
  bad_condition_type: "not a known condition", bad_minutes: "must be a whole number of minutes above 0",
  bad_min_minutes: "must be a whole number of minutes above 0", bad_away_minutes: "must be a whole number of minutes above 0",
  bad_flag: "must be on or off",
  bad_cooldown: "must be zero or more minutes", bad_actor: "missing who is saving this",
  bad_time: "the save time is invalid", bad_when: "not a known schedule",
  hours_not_set: "set the store's open hours first",
};

/** Plain text for a FieldProblem.reason -- never the raw code, on a page a
 *  manager (not a developer) reads. */
export function describeReason(reason) {
  return REASON_TEXT[reason] || String(reason);
}

// ---------------------------------------------------------------- the "Today's manager" status card

/** APPEARANCE-OF-DAY-SPEC.md's own "Known limits (say them on the page)" --
 *  the exact same wording site-client.mjs shows on the Site section's own
 *  match-threshold field (mirrored, not imported: these are two separate
 *  browser modules, never one importing the other). */
export const APPEARANCE_LIMITS_TEXT =
  "Clothing-colour matching is weak across cameras with very different lighting, "
  + "and useless under uniforms. It is uncalibrated until you record test walks.";

/**
 * GET /appearance/status's own `reason` strings (minted in exactly one
 * place, agent/detect-service.mjs's appearanceStatusForHealth) turned into
 * plain words for a manager or installer -- never the raw code (build rule
 * 11: report measurements, not jargon). `status` is that route's own body
 * shape: { enabled, learnedToday, hasSecondary, reason, ... }. Identity-free
 * throughout, same as every other piece of this page -- there is no name in
 * any branch below.
 */
export function appearanceStatusText(status) {
  if (!status || status.enabled !== true) return "Off for this site.";
  if (status.learnedToday) {
    const secondary = status.hasSecondary ? " A second manager was also learned today." : "";
    return `Learned today's manager.${secondary}`;
  }
  const reason = typeof status.reason === "string" ? status.reason : "";
  const sampleMatch = /^not enough sightings yet: (\d+) of (\d+)$/.exec(reason);
  if (sampleMatch) return `Not learned yet, ${sampleMatch[1]} of ${sampleMatch[2]}.`;
  if (reason === "open hours not set") return "Not learned: set the store's open hours first.";
  if (reason === "no manager's desk area") return "Not learned: mark an area as the manager's desk on the Cameras page first.";
  return reason ? `Not learned: ${reason}.` : "Not learned yet today.";
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

function svgEl(doc, tag, attrs) {
  const node = doc.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clearChildren(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function opt(doc, value, text) {
  return el(doc, "option", { value, text });
}

function minutesFromHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function hhmmFromMinutes(mins) {
  if (typeof mins !== "number" || !Number.isFinite(mins)) return "08:00";
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* ── the whole page ──────────────────────────────────────────────────── */

export function startRulesPage(opts) {
  const doc = opts.doc;
  const fetchFn = opts.fetchFn;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const navigate = typeof opts.navigate === "function" ? opts.navigate : () => {};

  const byId = (id) => (typeof doc.getElementById === "function" ? doc.getElementById(id) : null);

  const templatePicker = byId("templatePicker");
  const nameInput = byId("ruleName");
  const kindSelect = byId("ruleKind");
  const conditionSelect = byId("ruleCondition");
  const minutesRow = byId("ruleMinutesRow");
  const minutesInput = byId("ruleMinutes");
  const cameraSelect = byId("ruleCamera");
  const areaSelect = byId("ruleArea");
  const whenSelect = byId("ruleWhen");
  const alertBox = byId("ruleAlert");
  const reportBox = byId("ruleReport");
  const cooldownInput = byId("ruleCooldown");
  const sentenceEl = byId("ruleSentence");
  const hoursNoticeEl = byId("hoursNotice");
  const saveBtn = byId("ruleSave");
  const newBtn = byId("ruleNew");
  const saveStatus = byId("ruleSaveStatus");
  const errorsEl = byId("ruleErrors");
  const stillWrap = byId("ruleStillWrap");
  const stillImg = byId("ruleStill");
  const overlay = byId("ruleOverlay");
  const rulesListEl = byId("rulesList");
  const openHoursForm = byId("openHoursForm");
  const openHoursWeek = byId("openHoursWeek");
  const openHoursSave = byId("openHoursSave");
  const openHoursStatus = byId("openHoursStatus");
  const appearanceStatusEl = byId("appearanceStatusText");
  const appearanceLimitsEl = byId("appearanceLimitsText");

  let draft = blankDraft();
  let cameraNames = new Map(); // cameraId -> name
  let areasByCamera = new Map(); // cameraId -> [{id,name,points}]
  let templates = [];
  let rules = [];
  let openHours = null;
  const dayInputs = [];

  if (openHoursWeek) {
    for (let i = 0; i < 7; i++) {
      const dOpen = el(doc, "input", { type: "checkbox" });
      const dFrom = el(doc, "input", { type: "time" });
      const dTo = el(doc, "input", { type: "time" });
      dayInputs.push({ open: dOpen, from: dFrom, to: dTo });
      openHoursWeek.append(el(doc, "div", { class: "row" }, [
        el(doc, "label", {}, [dOpen, el(doc, "span", { text: DAY_NAMES[i] })]),
        el(doc, "label", { text: "from" }, [dFrom]),
        el(doc, "label", { text: "to" }, [dTo]),
      ]));
    }
  }

  function selectedAreas() {
    return areasByCamera.get(draft.cameraId) || [];
  }
  function areaNameFor(cameraId, areaId) {
    if (areaId === null) return null;
    const a = (areasByCamera.get(cameraId) || []).find((x) => x.id === areaId);
    return a ? a.name : null;
  }

  function renderCameraOptions() {
    if (!cameraSelect) return;
    clearChildren(cameraSelect);
    cameraSelect.append(opt(doc, "", "Choose a camera"));
    for (const [id, name] of cameraNames) cameraSelect.append(opt(doc, id, name));
    cameraSelect.value = draft.cameraId;
  }

  function renderAreaOptions() {
    if (!areaSelect) return;
    clearChildren(areaSelect);
    areaSelect.append(opt(doc, "", "Whole camera"));
    for (const a of selectedAreas()) areaSelect.append(opt(doc, a.id, a.name));
    areaSelect.value = draft.areaId ?? "";
  }

  function renderOutline() {
    if (!overlay) return;
    clearChildren(overlay);
    if (draft.areaId !== null) {
      const a = selectedAreas().find((x) => x.id === draft.areaId);
      if (a && Array.isArray(a.points)) {
        const pointsAttr = a.points.map(([x, y]) => `${x},${y}`).join(" ");
        overlay.append(svgEl(doc, "polygon", {
          points: pointsAttr, fill: "rgba(76,139,245,0.28)", stroke: "#4c8bf5", "stroke-width": 0.004,
        }));
      }
    }
    if (stillImg && draft.cameraId) {
      const atIso = new Date(now() - 90_000).toISOString();
      stillImg.src = `/still?camera=${encodeURIComponent(draft.cameraId)}&at=${encodeURIComponent(atIso)}`;
      if (stillWrap) stillWrap.hidden = false;
    } else if (stillWrap) {
      stillWrap.hidden = true;
    }
  }

  function minutesFieldNeeded() {
    return draft.conditionType === "absent_longer_than" || draft.conditionType === "present_longer_than"
      || draft.conditionType === "away_and_back"
      || draft.conditionType === "manager_leaves" || draft.conditionType === "manager_returns";
  }

  function minutesValueFor(d) {
    if (d.conditionType === "away_and_back") return d.minMinutes;
    if (d.conditionType === "manager_leaves" || d.conditionType === "manager_returns") return d.awayMinutes;
    return d.minutes;
  }

  function renderSentence() {
    if (!sentenceEl) return;
    const cameraName = cameraNames.get(draft.cameraId) || (draft.cameraId || "(no camera)");
    const areaName = areaNameFor(draft.cameraId, draft.areaId);
    sentenceEl.textContent = ruleSentence(draft, cameraName, areaName);
  }

  function needsHours() {
    return draft.when !== "always" && openHours === null;
  }

  function renderHoursNotice() {
    if (!hoursNoticeEl) return;
    if (needsHours()) {
      hoursNoticeEl.textContent = "Set the store's open hours first — see Open hours below.";
      hoursNoticeEl.hidden = false;
    } else {
      hoursNoticeEl.textContent = "";
      hoursNoticeEl.hidden = true;
    }
  }

  function renderAppearanceStatus(status) {
    if (appearanceStatusEl) {
      appearanceStatusEl.textContent = appearanceStatusText(status);
      appearanceStatusEl.className = status && status.enabled && status.learnedToday ? "good" : (status && status.enabled ? "warn" : "dim");
    }
    if (appearanceLimitsEl) appearanceLimitsEl.textContent = APPEARANCE_LIMITS_TEXT;
  }

  function applyDraftToForm() {
    if (nameInput) nameInput.value = draft.name;
    if (kindSelect) kindSelect.value = draft.kind;
    if (conditionSelect) conditionSelect.value = draft.conditionType;
    if (minutesRow) minutesRow.hidden = !minutesFieldNeeded();
    if (minutesInput) minutesInput.value = String(minutesValueFor(draft));
    renderCameraOptions();
    renderAreaOptions();
    if (whenSelect) whenSelect.value = draft.when;
    if (alertBox) alertBox.checked = draft.alert;
    if (reportBox) reportBox.checked = draft.report;
    if (cooldownInput) cooldownInput.value = String(draft.cooldownMinutes);
    renderOutline();
    renderSentence();
    renderHoursNotice();
    if (saveBtn) saveBtn.disabled = needsHours();
  }

  function renderTemplates() {
    if (!templatePicker) return;
    clearChildren(templatePicker);
    for (const def of templates) {
      const btn = el(doc, "button", { type: "button", class: "template-btn" });
      // Untrusted-in-principle, but templates come from our own server data;
      // still textContent, never innerHTML, matching this whole file's rule.
      btn.textContent = def.label;
      btn.addEventListener("click", () => {
        draft = draftFromTemplate(def);
        applyDraftToForm();
      });
      templatePicker.append(btn);
    }
  }

  function renderErrors(errors) {
    if (!errorsEl) return;
    clearChildren(errorsEl);
    if (!Array.isArray(errors) || errors.length === 0) return;
    const ul = el(doc, "ul", {}, []);
    for (const e of errors) ul.append(el(doc, "li", { text: `${e.field}: ${describeReason(e.reason)}` }));
    errorsEl.append(el(doc, "p", { text: "This rule could not be saved:" }), ul);
  }

  function renderRulesList() {
    if (!rulesListEl) return;
    clearChildren(rulesListEl);
    if (rules.length === 0) {
      rulesListEl.append(el(doc, "p", { class: "dim", text: "No rules yet." }));
      return;
    }
    for (const r of rules) {
      const cameraName = cameraNames.get(r.cameraId) || r.cameraId;
      const areaName = areaNameFor(r.cameraId, r.areaId);
      const nameEl = el(doc, "strong", {});
      nameEl.textContent = r.name; // untrusted: textContent only
      const sentence = el(doc, "p", { class: "dim" });
      sentence.textContent = ruleSentence({
        kind: r.kind, conditionType: r.condition.type,
        minutes: r.condition.minutes, minMinutes: r.condition.minMinutes,
        awayMinutes: r.condition.awayMinutes, when: r.when,
        alert: r.notify.alert, report: r.notify.report,
      }, cameraName, areaName);
      const onOff = el(doc, "input", { type: "checkbox" });
      onOff.checked = r.enabled;
      onOff.addEventListener("change", () => { void toggleRule(r, onOff.checked); });
      const editBtn = el(doc, "button", { type: "button", text: "Edit" });
      editBtn.addEventListener("click", () => {
        draft = draftFromRule(r);
        applyDraftToForm();
      });
      const row = el(doc, "li", { class: "rule-row" }, [
        // Its own class, not the shared ".row": the base `label { flex-
        // direction:column; font-size:12px; color:var(--muted); }` rule
        // (written for this form's OWN field labels, e.g. "Name<input>")
        // wins on those three properties over ".row" no matter which class
        // list this element also carries, since ".row" never redeclares
        // them -- ".rule-toggle" (rules.html) does, so the on/off switch and
        // the rule's own name render as one normal-size inline row.
        el(doc, "label", { class: "rule-toggle" }, [onOff, nameEl]),
        sentence,
        editBtn,
      ]);
      rulesListEl.append(row);
    }
  }

  async function toggleRule(rule, enabled) {
    try {
      const res = await fetchFn("/rules", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rule, enabled }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok !== false) {
        rules = rules.map((r) => (r.id === rule.id ? data.rule : r));
        renderRulesList();
      }
    } catch (err) {
      log("error", "rule toggle failed", { id: rule.id, message: err && err.message });
    }
  }

  async function saveRule() {
    draft.name = nameInput ? nameInput.value : draft.name;
    if (needsHours()) return;
    if (saveBtn) saveBtn.disabled = true;
    if (saveStatus) saveStatus.textContent = "Saving…";
    clearChildren(errorsEl);
    try {
      const res = await fetchFn("/rules", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRuleBody(draft)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (data && Array.isArray(data.errors)) renderErrors(data.errors);
        else if (saveStatus) saveStatus.textContent = (data && data.message) || "Something went wrong.";
        return;
      }
      rules = [...rules.filter((r) => r.id !== data.rule.id), data.rule];
      renderRulesList();
      if (saveStatus) saveStatus.textContent = "Saved.";
      draft = draftFromRule(data.rule);
      applyDraftToForm();
    } catch (err) {
      log("error", "rule save failed", { message: err && err.message });
      if (saveStatus) saveStatus.textContent = "Could not reach the recorder.";
    } finally {
      if (saveBtn) saveBtn.disabled = needsHours();
    }
  }

  function wireForm() {
    if (nameInput) nameInput.addEventListener("input", () => { draft.name = nameInput.value; });
    if (kindSelect) kindSelect.addEventListener("change", () => { draft.kind = kindSelect.value; renderSentence(); });
    if (conditionSelect) conditionSelect.addEventListener("change", () => {
      draft.conditionType = conditionSelect.value;
      applyDraftToForm();
    });
    if (minutesInput) minutesInput.addEventListener("input", () => {
      const n = Number(minutesInput.value);
      if (draft.conditionType === "away_and_back") draft.minMinutes = n;
      else if (draft.conditionType === "manager_leaves" || draft.conditionType === "manager_returns") draft.awayMinutes = n;
      else draft.minutes = n;
      renderSentence();
    });
    if (cameraSelect) cameraSelect.addEventListener("change", () => {
      draft.cameraId = cameraSelect.value;
      draft.areaId = null;
      renderAreaOptions();
      renderOutline();
      renderSentence();
    });
    if (areaSelect) areaSelect.addEventListener("change", () => {
      draft.areaId = areaSelect.value === "" ? null : areaSelect.value;
      renderOutline();
      renderSentence();
    });
    if (whenSelect) whenSelect.addEventListener("change", () => {
      draft.when = whenSelect.value;
      renderSentence();
      renderHoursNotice();
      if (saveBtn) saveBtn.disabled = needsHours();
    });
    if (alertBox) alertBox.addEventListener("change", () => { draft.alert = alertBox.checked; renderSentence(); });
    if (reportBox) reportBox.addEventListener("change", () => { draft.report = reportBox.checked; renderSentence(); });
    if (cooldownInput) cooldownInput.addEventListener("input", () => { draft.cooldownMinutes = Number(cooldownInput.value); });
    if (saveBtn) saveBtn.addEventListener("click", () => { void saveRule(); });
    if (newBtn) newBtn.addEventListener("click", () => { draft = blankDraft(); applyDraftToForm(); if (saveStatus) saveStatus.textContent = ""; });
    if (openHoursSave) openHoursSave.addEventListener("click", () => { void saveOpenHours(); });
  }

  function applyOpenHoursToForm() {
    if (!openHoursForm) return;
    const isSet = openHours !== null;
    if (openHoursStatus) {
      openHoursStatus.textContent = isSet ? "Open hours are set." : "Not set — rules using open or closed hours are refused until this is set.";
    }
    for (let i = 0; i < 7; i++) {
      const day = isSet ? (openHours.weekly[i] || [])[0] : null;
      dayInputs[i].open.checked = day !== undefined && day !== null;
      dayInputs[i].from.value = day ? hhmmFromMinutes(day.open) : "08:00";
      dayInputs[i].to.value = day ? hhmmFromMinutes(day.close) : "18:00";
    }
  }

  async function saveOpenHours() {
    const timeZone = openHours && openHours.timeZone ? openHours.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const weekly = dayInputs.map((d) => {
      if (!d.open.checked) return [];
      const from = minutesFromHHMM(d.from.value);
      const to = minutesFromHHMM(d.to.value);
      if (from === null || to === null) return [];
      return [{ open: from, close: to }];
    });
    if (openHoursStatus) openHoursStatus.textContent = "Saving…";
    try {
      const res = await fetchFn("/open-hours", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openHours: { timeZone, weekly, closedDates: [] } }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        if (openHoursStatus) openHoursStatus.textContent = (data && data.message) || "Could not save open hours.";
        return;
      }
      openHours = data.openHours;
      applyOpenHoursToForm();
      renderHoursNotice();
      if (saveBtn) saveBtn.disabled = needsHours();
    } catch (err) {
      log("error", "open hours save failed", { message: err && err.message });
      if (openHoursStatus) openHoursStatus.textContent = "Could not reach the recorder.";
    }
  }

  wireForm();

  async function load() {
    let templatesRes; let rulesRes; let areasRes; let camerasRes; let hoursRes; let appearanceRes;
    try {
      [templatesRes, rulesRes, areasRes, camerasRes, hoursRes, appearanceRes] = await Promise.all([
        fetchFn("/rule-templates", { credentials: "same-origin" }),
        fetchFn("/rules", { credentials: "same-origin" }),
        fetchFn("/areas/list", { credentials: "same-origin" }),
        fetchFn("/cameras", { credentials: "same-origin" }),
        fetchFn("/open-hours", { credentials: "same-origin" }),
        fetchFn("/appearance/status", { credentials: "same-origin" }),
      ]);
      if ([templatesRes, rulesRes, areasRes, camerasRes, hoursRes, appearanceRes].some((r) => r && r.status === 401)) {
        navigate("/login?next=%2Frules-page");
        return;
      }
    } catch (err) {
      log("error", "rules page could not load", { message: err && err.message });
      return;
    }
    const templatesBody = (await templatesRes.json().catch(() => null)) || { templates: [] };
    const rulesBody = (await rulesRes.json().catch(() => null)) || { rules: [] };
    const areasBody = (await areasRes.json().catch(() => null)) || { areas: [] };
    const camerasBody = (await camerasRes.json().catch(() => null)) || [];
    const hoursBody = (await hoursRes.json().catch(() => null)) || { openHours: null };
    // Tolerant: a 404 (feature_off) or any other non-2xx still means SOMETHING
    // for the card to say ("Off for this site.", via appearanceStatusText's
    // own `enabled !== true` branch) rather than a blank card or a thrown
    // error -- the same "no" reads as an honest status, never a crash.
    const appearanceBody = (await appearanceRes.json().catch(() => null)) || { enabled: false, learnedToday: false, reason: null };

    templates = Array.isArray(templatesBody.templates) ? templatesBody.templates : [];
    rules = Array.isArray(rulesBody.rules) ? rulesBody.rules : [];
    openHours = hoursBody.openHours ?? null;

    cameraNames = new Map();
    if (Array.isArray(camerasBody)) {
      for (const c of camerasBody) {
        if (c && typeof c.cameraId === "string") {
          cameraNames.set(c.cameraId, typeof c.name === "string" && c.name !== "" ? c.name : c.cameraId);
        }
      }
    }
    areasByCamera = new Map();
    const areasList = Array.isArray(areasBody.areas) ? areasBody.areas : [];
    for (const a of areasList) {
      const list = areasByCamera.get(a.cameraId) || [];
      list.push(a);
      areasByCamera.set(a.cameraId, list);
    }

    renderAppearanceStatus(appearanceBody);
    renderTemplates();
    applyDraftToForm();
    renderRulesList();
    applyOpenHoursToForm();
  }

  const ready = load();
  return { ready, reload: load, getDraft: () => draft };
}

export { blankDraft as newDraft };

// Browser bootstrap. Runs only when the real page has its own container in
// the DOM; a harness importing this module for its pure helpers has no side
// effects. Copies camera-page-bootstrap-lesson: every new NVR page client
// needs this, and harness/rulesPage.harness.mjs proves it.
if (typeof document !== "undefined" &&
    typeof document.getElementById === "function" &&
    document.getElementById("rulesBody")) {
  startRulesPage({
    doc: document,
    fetchFn: function (url, init) { return fetch(url, init); },
    now: () => Date.now(),
    navigate: (url) => { window.location.assign(url); },
    log: () => {},
  });
}
