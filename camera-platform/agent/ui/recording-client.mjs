const whoamiEl = document.getElementById("whoami");
const messageEl = document.getElementById("message");
const signOutEl = document.getElementById("signOut");
const storageErrorEl = document.getElementById("storageError");
const storeListEl = document.getElementById("storeList");
const retentionLineEl = document.getElementById("retentionLine");
const settingsNoticeEl = document.getElementById("settingsNotice");
const currentSettingEl = document.getElementById("currentSetting");
const limitNoneEl = document.getElementById("limitNone");
const limitDaysEl = document.getElementById("limitDays");
const daysEl = document.getElementById("days");
const saveRetentionEl = document.getElementById("saveRetention");
const fillsFirstEl = document.getElementById("fillsFirst");
const confirmDeleteEl = document.getElementById("confirmDelete");
const confirmDeleteTextEl = document.getElementById("confirmDeleteText");
const confirmYesEl = document.getElementById("confirmDeleteYes");
const confirmNoEl = document.getElementById("confirmDeleteNo");

let minDaysLimit = 1;
let maxDaysLimit = 365;
let retentionInfo = null;
let pendingBody = null;

class HaltError extends Error {
  constructor() {
    super("redirecting to sign-in");
    this.halt = true;
  }
}

class NetworkError extends Error {
  constructor() {
    super("network error");
    this.network = true;
  }
}

class RequestError extends Error {
  constructor(message, field, status, data) {
    super(message);
    this.field = typeof field === "string" && field !== "" ? field : null;
    this.status = typeof status === "number" ? status : null;
    this.data = data || null;
  }
}

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError();
  }
  if (response.status === 401) {
    location.replace("/login?next=%2Frecording-page");
    throw new HaltError();
  }
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }
  if (!response.ok || !data || data.ok === false) {
    const message = data && typeof data.message === "string" && data.message !== ""
      ? data.message
      : `Request failed (${response.status}).`;
    throw new RequestError(message, data && data.field, response.status, data);
  }
  return data;
}

function showMessage(text, kind) {
  messageEl.textContent = text;
  messageEl.className = kind === "error" ? "error" : (kind === "good" ? "good" : "");
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    if (err && err.halt) return;
    if (err && err.network) {
      showMessage("Could not reach the recorder.", "error");
      return;
    }
    showMessage(err && err.message ? err.message : "Something went wrong.", "error");
  }
}

function clearBad() {
  const bad = document.querySelectorAll("input.bad, select.bad");
  for (const el of bad) el.classList.remove("bad");
}

function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function gb(bytes) {
  return (bytes / 1e9).toFixed(1);
}

async function loadHealth() {
  try {
    const data = await api("GET", "/health");
    storageErrorEl.hidden = true;
    storageErrorEl.textContent = "";
    renderHealth(data || {});
  } catch (err) {
    if (err && err.halt) throw err;
    retentionInfo = null;
    storeListEl.textContent = "";
    renderRetention();
    updateFillsFirst();
    storageErrorEl.textContent = err && err.network
      ? "Could not reach the recorder."
      : (err && err.message ? err.message : "Something went wrong.");
    storageErrorEl.hidden = false;
  }
}

function renderHealth(data) {
  const stores = Array.isArray(data.stores) ? data.stores : [];
  storeListEl.textContent = "";
  if (stores.length === 0) {
    const empty = document.createElement("p");
    empty.className = "dim";
    empty.textContent = "No drives reported.";
    storeListEl.append(empty);
  } else {
    for (const store of stores) storeListEl.append(storeRow(store));
  }
  retentionInfo = data.retention || null;
  renderRetention();
  updateFillsFirst();
}

function storeRow(store) {
  const row = document.createElement("div");
  row.className = "row";
  const root = document.createElement("strong");
  root.textContent = store.root;
  row.append(root);
  const state = document.createElement("span");
  state.textContent = store.state;
  row.append(state);
  const usage = document.createElement("span");
  usage.className = "dim";
  usage.textContent = usageText(store);
  row.append(usage);
  return row;
}

function usageText(store) {
  const used = hasNumber(store.usedBytes) ? `${gb(store.usedBytes)} GB` : "not measured";
  const total = hasNumber(store.totalBytes) ? `${gb(store.totalBytes)} GB` : "not measured";
  const percent = hasNumber(store.usedFraction) ? `${Math.round(store.usedFraction * 100)}%` : "not measured";
  return `${used} used of ${total} (${percent})`;
}

function renderRetention() {
  if (!retentionInfo) {
    retentionLineEl.hidden = true;
    retentionLineEl.textContent = "";
    return;
  }
  retentionLineEl.hidden = false;
  if (retentionInfo.kind === "ok") {
    retentionLineEl.textContent = `At the current recording rate the drives hold about ${Math.floor(retentionInfo.days)} days`;
  } else {
    retentionLineEl.textContent = `How long the drives hold can't be worked out yet: ${retentionInfo.message}`;
  }
}

function selectedMaxDays() {
  if (limitNoneEl.checked) return null;
  const value = Number(daysEl.value);
  return Number.isFinite(value) ? value : null;
}

function updateFillsFirst() {
  const limit = selectedMaxDays();
  const fills = limit !== null && retentionInfo && retentionInfo.kind === "ok"
    && hasNumber(retentionInfo.days) && limit > retentionInfo.days;
  if (fills) {
    fillsFirstEl.textContent = `The drives fill in about ${Math.floor(retentionInfo.days)} days, before this limit, so the oldest recordings will be deleted sooner.`;
    fillsFirstEl.hidden = false;
  } else {
    fillsFirstEl.hidden = true;
    fillsFirstEl.textContent = "";
  }
}

async function loadSettings() {
  const data = await api("GET", "/recording-settings");
  minDaysLimit = hasNumber(data.minDays) ? data.minDays : 1;
  maxDaysLimit = hasNumber(data.maxDays) ? data.maxDays : 365;
  renderSettings(data);
}

function renderSettings(data) {
  if (data.problem) {
    settingsNoticeEl.textContent = "The saved setting could not be read, so no age limit is applied. Save a setting to fix it.";
    settingsNoticeEl.hidden = false;
  } else {
    settingsNoticeEl.hidden = true;
    settingsNoticeEl.textContent = "";
  }
  const saved = data.settings && hasNumber(data.settings.maxDays) ? data.settings.maxDays : null;
  limitNoneEl.checked = saved === null;
  limitDaysEl.checked = saved !== null;
  if (saved !== null) daysEl.value = String(saved);
  daysEl.min = String(minDaysLimit);
  daysEl.max = String(maxDaysLimit);
  syncDaysEnabled();
  renderCurrentSetting(data.settings);
  updateFillsFirst();
}

function renderCurrentSetting(settings) {
  const saved = settings && hasNumber(settings.maxDays) ? settings.maxDays : null;
  if (saved === null) {
    currentSettingEl.textContent = "Now: kept until the drives are full";
  } else {
    currentSettingEl.textContent = `Now: kept for ${saved} days (and less if the drives fill first)`;
  }
}

function syncDaysEnabled() {
  daysEl.disabled = !limitDaysEl.checked;
}

function requestedMaxDays() {
  clearBad();
  if (limitNoneEl.checked) return null;
  const text = daysEl.value.trim();
  const value = Number(text);
  if (text === "" || !Number.isInteger(value) || value < minDaysLimit || value > maxDaysLimit) {
    daysEl.classList.add("bad");
    showMessage(`Enter a whole number of days from ${minDaysLimit} to ${maxDaysLimit}.`, "error");
    return undefined;
  }
  return value;
}

async function saveRetention() {
  const value = requestedMaxDays();
  if (value === undefined) return;
  pendingBody = { maxDays: value };
  await sendSave(pendingBody);
}

async function sendSave(body) {
  setBusy(true);
  try {
    const data = await api("POST", "/recording-settings", body);
    pendingBody = null;
    hideConfirm();
    showMessage("Saved.", "good");
    renderCurrentSetting(data.settings);
    updateFillsFirst();
  } catch (err) {
    if (err && err.halt) throw err;
    if (err && err.network) {
      showMessage("Could not reach the recorder.", "error");
      return;
    }
    if (err && err.status === 409 && err.data && err.data.code === "would_delete") {
      showConfirm(err.data.wouldDelete || {});
      return;
    }
    if (err && err.field === "maxDays") daysEl.classList.add("bad");
    showMessage(err && err.message ? err.message : "Something went wrong.", "error");
  } finally {
    setBusy(false);
  }
}

function showConfirm(wouldDelete) {
  const count = hasNumber(wouldDelete.segments) ? String(wouldDelete.segments) : "unknown";
  const size = hasNumber(wouldDelete.bytes) ? `${gb(wouldDelete.bytes)} GB` : "not measured";
  confirmDeleteTextEl.textContent = `This deletes ${count} recordings (${size}) already on the drives, going back to ${oldestText(wouldDelete.oldestUtc)}. They are deleted within 5 minutes and cannot be recovered. Recordings marked as held are kept.`;
  confirmDeleteEl.hidden = false;
}

function oldestText(oldestUtc) {
  if (typeof oldestUtc !== "string" || oldestUtc === "") return "unknown";
  const date = new Date(oldestUtc);
  return Number.isNaN(date.getTime()) ? oldestUtc : date.toLocaleString();
}

function hideConfirm() {
  pendingBody = null;
  confirmDeleteEl.hidden = true;
}

function setBusy(busy) {
  saveRetentionEl.disabled = busy;
  confirmYesEl.disabled = busy;
  confirmNoEl.disabled = busy;
}

function onSettingInput() {
  syncDaysEnabled();
  hideConfirm();
  updateFillsFirst();
}

async function signOut() {
  await api("POST", "/auth/logout", {});
  location.replace("/login");
}

async function init() {
  const state = await api("GET", "/auth/state");
  const principal = (state && state.principal) || {};
  if (principal.username) {
    whoamiEl.textContent = `Signed in as ${principal.username} (${principal.role})`;
  } else {
    whoamiEl.textContent = "Signed in";
  }
  await Promise.all([run(loadHealth), run(loadSettings)]);
}

function wireEvents() {
  signOutEl.addEventListener("click", () => {
    run(signOut);
  });
  saveRetentionEl.addEventListener("click", () => {
    run(saveRetention);
  });
  confirmYesEl.addEventListener("click", () => {
    if (!pendingBody) return;
    const body = { maxDays: pendingBody.maxDays, confirm: true };
    run(() => sendSave(body));
  });
  confirmNoEl.addEventListener("click", () => {
    hideConfirm();
    showMessage("Not saved.");
  });
  limitNoneEl.addEventListener("change", onSettingInput);
  limitDaysEl.addEventListener("change", onSettingInput);
  daysEl.addEventListener("input", onSettingInput);
}

async function start() {
  wireEvents();
  await run(init);
}

start();
