const whoamiEl = document.getElementById("whoami");
const messageEl = document.getElementById("message");
const signOutEl = document.getElementById("signOut");
const cameraNoticeEl = document.getElementById("cameraNotice");
const cameraNoticeTextEl = document.getElementById("cameraNoticeText");
const cameraListEl = document.getElementById("cameraList");
const cameraFormEl = document.getElementById("cameraForm");
const formTitleEl = document.getElementById("formTitle");
const cameraIdEl = document.getElementById("cameraId");
const cameraNameEl = document.getElementById("cameraName");
const vendorEl = document.getElementById("vendor");
const hostFieldsEl = document.getElementById("hostFields");
const hostEl = document.getElementById("host");
const channelEl = document.getElementById("channel");
const streamEl = document.getElementById("stream");
const urlFieldsEl = document.getElementById("urlFields");
const urlEl = document.getElementById("url");
const bitrateEl = document.getElementById("bitrate");
const saveCameraEl = document.getElementById("saveCamera");
const cancelEditEl = document.getElementById("cancelEdit");
const loginStatusEl = document.getElementById("loginStatus");
const loginFormEl = document.getElementById("loginForm");
const loginUserEl = document.getElementById("loginUser");
const loginPasswordEl = document.getElementById("loginPassword");
const saveLoginEl = document.getElementById("saveLogin");

let editingId = null;

const fieldElements = {
  cameraId: cameraIdEl,
  name: cameraNameEl,
  host: hostEl,
  url: urlEl,
  vendor: vendorEl,
  channel: channelEl,
  stream: streamEl,
  bitrateKbps: bitrateEl,
  username: loginUserEl,
  password: loginPasswordEl,
};

const knownVendors = ["hikvision", "axis", "hanwha", "avigilon", "avycon"];

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
  constructor(message, field) {
    super(message);
    this.field = typeof field === "string" && field !== "" ? field : null;
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
    location.replace("/login?next=%2Fcameras-page");
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
    throw new RequestError(message, data && data.field);
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
    if (err && err.field) markBadField(err.field);
    showMessage(err && err.message ? err.message : "Something went wrong.", "error");
  }
}

function markBadField(field) {
  const el = fieldElements[field];
  if (!el) return;
  el.classList.add("bad");
  el.focus();
}

function clearBad() {
  const bad = document.querySelectorAll("input.bad, select.bad");
  for (const el of bad) el.classList.remove("bad");
}

async function loadSettings() {
  const data = await api("GET", "/camera-settings");
  renderNotice(data.fileProblem);
  renderCameras(data.cameras || []);
  renderLogin(data.login || {});
}

function renderNotice(fileProblem) {
  if (!fileProblem) {
    cameraNoticeTextEl.textContent = "";
    cameraNoticeEl.hidden = true;
    return;
  }
  cameraNoticeTextEl.textContent = `The saved camera list could not be read (${fileProblem}). The recorder is using its original list.`;
  cameraNoticeEl.hidden = false;
}

function renderCameras(cameras) {
  cameraListEl.textContent = "";
  if (cameras.length === 0) {
    const empty = document.createElement("p");
    empty.className = "dim";
    empty.textContent = "No cameras yet.";
    cameraListEl.append(empty);
    return;
  }
  for (const camera of cameras) {
    cameraListEl.append(cameraRow(camera));
  }
}

function cameraRow(camera) {
  const row = document.createElement("div");
  row.className = "row";

  const id = document.createElement("strong");
  id.textContent = camera.cameraId;
  row.append(id);

  const name = document.createElement("span");
  if (camera.name) {
    name.textContent = camera.name;
  } else {
    name.className = "dim";
    name.textContent = "no name";
  }
  row.append(name);

  const description = document.createElement("span");
  description.className = "dim";
  description.textContent = describeCamera(camera);
  row.append(description);

  if (camera.bitrateKbps !== undefined && camera.bitrateKbps !== null && camera.bitrateKbps !== "") {
    const bitrate = document.createElement("span");
    bitrate.className = "dim";
    bitrate.textContent = `${camera.bitrateKbps} kbps`;
    row.append(bitrate);
  }

  if (camera.problem) {
    const problem = document.createElement("span");
    problem.className = "error";
    problem.textContent = `Needs fixing — ${problemText(camera.problem)}`;
    row.append(problem);
  }

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => {
    startEdit(camera);
  });
  row.append(editButton);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "danger";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => {
    run(() => removeCamera(camera.cameraId));
  });
  row.append(removeButton);

  return row;
}

function describeCamera(camera) {
  if (camera.url) return camera.url;
  const parts = [];
  if (camera.host) parts.push(camera.host);
  if (camera.vendor) parts.push(camera.vendor);
  if (camera.channel !== undefined && camera.channel !== null) parts.push(`channel ${camera.channel}`);
  if (camera.stream) parts.push(`${camera.stream} stream`);
  return parts.join(" · ");
}

function problemText(problem) {
  if (problem === "url_has_login") return "remove the user and password from its address";
  if (problem === "generic_needs_url") return "enter its full stream address";
  return problem;
}

async function removeCamera(cameraId) {
  if (!window.confirm(`Remove camera ${cameraId}? Its recordings stay on disk.`)) return;
  await api("DELETE", `/cameras/${encodeURIComponent(cameraId)}`);
  await loadSettings();
  showMessage(`Camera ${cameraId} removed.`, "good");
}

function syncVendorFields() {
  const other = vendorEl.value === "other";
  hostFieldsEl.hidden = other;
  urlFieldsEl.hidden = !other;
}

function startEdit(camera) {
  editingId = camera.cameraId;
  clearBad();
  cameraFormEl.reset();
  cameraIdEl.value = camera.cameraId;
  cameraIdEl.readOnly = true;
  cameraNameEl.value = camera.name || "";
  bitrateEl.value = camera.bitrateKbps === undefined || camera.bitrateKbps === null ? "" : String(camera.bitrateKbps);
  const urlCamera = (typeof camera.url === "string" && camera.url !== "") || camera.vendor === "generic";
  if (urlCamera) {
    vendorEl.value = "other";
    if (camera.problem === "url_has_login") {
      urlEl.value = "";
      showMessage("Re-enter this camera's address without the user and password.", "error");
    } else {
      urlEl.value = camera.url || "";
    }
  } else {
    vendorEl.value = knownVendors.includes(camera.vendor) ? camera.vendor : "hikvision";
    hostEl.value = camera.host || "";
    channelEl.value = camera.channel === undefined || camera.channel === null ? "1" : String(camera.channel);
    streamEl.value = camera.stream || "main";
  }
  syncVendorFields();
  formTitleEl.textContent = `Edit ${camera.cameraId}`;
  saveCameraEl.textContent = "Save changes";
  cancelEditEl.hidden = false;
  cameraFormEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetFormToAddMode() {
  editingId = null;
  cameraFormEl.reset();
  cameraIdEl.readOnly = false;
  formTitleEl.textContent = "Add camera";
  saveCameraEl.textContent = "Add camera";
  cancelEditEl.hidden = true;
  clearBad();
  syncVendorFields();
}

function buildCameraBody() {
  const body = { cameraId: cameraIdEl.value };
  const name = cameraNameEl.value.trim();
  if (name !== "") body.name = name;
  const bitrate = bitrateEl.value.trim();
  if (bitrate !== "") body.bitrateKbps = Number(bitrate);
  if (vendorEl.value === "other") {
    body.url = urlEl.value;
  } else {
    body.host = hostEl.value;
    body.vendor = vendorEl.value;
    body.channel = Number(channelEl.value);
    body.stream = streamEl.value;
  }
  return body;
}

async function saveCamera() {
  clearBad();
  const cameraId = cameraIdEl.value;
  const editing = editingId !== null;
  const body = buildCameraBody();
  saveCameraEl.disabled = true;
  try {
    if (editing) {
      await api("POST", `/cameras/${encodeURIComponent(editingId)}`, body);
    } else {
      await api("POST", "/cameras", body);
    }
    showMessage(editing ? `Camera ${cameraId} saved.` : `Camera ${cameraId} added.`, "good");
    resetFormToAddMode();
    await loadSettings();
  } finally {
    saveCameraEl.disabled = false;
  }
}

function renderLogin(login) {
  const username = login && typeof login.username === "string" && login.username !== "" ? login.username : null;
  const passwordSet = Boolean(login && login.passwordSet);
  if (username === null) {
    loginStatusEl.textContent = "Used for every camera. Currently: not set";
  } else if (passwordSet) {
    loginStatusEl.textContent = `Used for every camera. Currently: ${username} (password set)`;
  } else {
    loginStatusEl.textContent = `Used for every camera. Currently: ${username}`;
  }
  if (loginUserEl.value === "") {
    loginUserEl.value = username === null ? "" : username;
  }
}

async function saveLogin() {
  clearBad();
  const username = loginUserEl.value;
  const password = loginPasswordEl.value;
  saveLoginEl.disabled = true;
  try {
    await api("POST", "/camera-login", { username: username, password: password });
    loginPasswordEl.value = "";
    showMessage("Camera login saved.", "good");
    await loadSettings();
  } finally {
    saveLoginEl.disabled = false;
  }
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
  await loadSettings();
}

function wireEvents() {
  signOutEl.addEventListener("click", () => {
    run(signOut);
  });
  cameraFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    run(saveCamera);
  });
  cancelEditEl.addEventListener("click", () => {
    resetFormToAddMode();
  });
  vendorEl.addEventListener("change", syncVendorFields);
  loginFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    run(saveLogin);
  });
}

async function start() {
  wireEvents();
  syncVendorFields();
  await run(init);
}

start();
