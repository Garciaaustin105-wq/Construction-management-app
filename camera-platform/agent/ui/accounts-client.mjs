const whoamiEl = document.getElementById("whoami");
const messageEl = document.getElementById("message");
const accountListEl = document.getElementById("accountList");
const addAccountFormEl = document.getElementById("addAccountForm");
const addUsernameEl = document.getElementById("addUsername");
const addRoleEl = document.getElementById("addRole");
const addPasswordEl = document.getElementById("addPassword");
const addConfirmEl = document.getElementById("addConfirm");
const addAccountButtonEl = document.getElementById("addAccountButton");
const displayListEl = document.getElementById("displayList");
const addDisplayFormEl = document.getElementById("addDisplayForm");
const addDisplayIdEl = document.getElementById("addDisplayId");
const addDisplayButtonEl = document.getElementById("addDisplayButton");
const newDisplayTokenEl = document.getElementById("newDisplayToken");
const newDisplayLinkEl = document.getElementById("newDisplayLink");
const copyDisplayLinkEl = document.getElementById("copyDisplayLink");
const dismissDisplayTokenEl = document.getElementById("dismissDisplayToken");
const signOutEl = document.getElementById("signOut");
const displayLayoutEditorEl = document.getElementById("displayLayoutEditor");
const displayLayoutTitleEl = document.getElementById("displayLayoutTitle");
const displayLayoutShapeEl = document.getElementById("displayLayoutShape");
const displayLayoutCellsEl = document.getElementById("displayLayoutCells");
const displayLayoutErrorsEl = document.getElementById("displayLayoutErrors");
const displayLayoutSaveEl = document.getElementById("displayLayoutSave");
const displayLayoutCancelEl = document.getElementById("displayLayoutCancel");

let signedInUsername = null;

// Mirrored from contracts/gridLayout.mts's own GRID_SHAPES -- that file
// compiles as an ES module for the BROWSER's own use at /ui/grid-layout.js,
// but a static top-level import of an absolute "/ui/..." path here would
// break every harness that imports this file directly by its real filename
// (Node resolves "/ui/grid-layout.js" as a filesystem path, which does not
// exist), the same reason camera-ai-client.mjs mirrors CAMERA-AI-SETTINGS
// contract constants instead of importing dist/cameraAiSettings.js. This is
// the contract's own source of truth; harness/accountsPage.harness.mjs
// checks this copy still matches it.
export const GRID_SHAPES = [
  { id: "1x1", cells: 1 },
  { id: "2x2", cells: 4 },
  { id: "3x3", cells: 9 },
  { id: "4x4", cells: 16 },
  { id: "5x5", cells: 25 },
  { id: "6x6", cells: 36 },
];

// Mirrored from agent/ui/accounts.html's own <option> text for #addRole
// (MANAGER-RULES-SPEC.md section 4: the new `manager` role, "can make
// rules and see reports; cannot change cameras, storage or accounts").
// harness/accountsPage.harness.mjs checks the picker's own option text
// against this, so the two can never drift apart into two different
// descriptions of what a manager account can do.
export const ROLE_DESCRIPTIONS = {
  store: "watch, review, export",
  manager: "can make rules and see reports; cannot change cameras, storage or accounts",
  installer: "everything",
};

let cameraOptions = []; // [{id, name}], from GET /camera-settings
let displayLayoutsData = {}; // displayId -> { layout, cells } (raw, unresolved)
let editingDisplayId = null;

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
  constructor(message) {
    super(message);
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
    location.replace("/login?next=%2Faccounts-page");
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
    throw new RequestError(message);
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

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

async function loadAccounts() {
  const data = await api("GET", "/accounts");
  renderAccounts(data.accounts || []);
}

function renderAccounts(accounts) {
  accountListEl.textContent = "";
  if (accounts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "dim";
    empty.textContent = "No accounts yet.";
    accountListEl.append(empty);
    return;
  }
  for (const account of accounts) {
    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("strong");
    name.textContent = account.username;
    row.append(name);

    if (signedInUsername !== null && account.username === signedInUsername) {
      const you = document.createElement("span");
      you.textContent = "(you)";
      row.append(you);
    }

    const role = document.createElement("span");
    role.className = "dim";
    role.textContent = account.role;
    row.append(role);

    const roleDescription = ROLE_DESCRIPTIONS[account.role];
    if (roleDescription) {
      const description = document.createElement("span");
      description.className = "dim";
      description.textContent = `(${roleDescription})`;
      row.append(description);
    }

    const created = document.createElement("span");
    created.className = "dim";
    created.textContent = formatDate(account.createdUtc);
    row.append(created);

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.textContent = "Reset password";
    resetButton.addEventListener("click", () => {
      run(() => resetPassword(account.username));
    });
    row.append(resetButton);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      run(() => removeAccount(account.username));
    });
    row.append(removeButton);

    accountListEl.append(row);
  }
}

async function loadDisplays() {
  const data = await api("GET", "/displays");
  renderDisplays(data.displays || []);
}

async function loadCameraOptions() {
  const data = await api("GET", "/camera-settings");
  cameraOptions = (data.cameras || [])
    .filter((c) => c && typeof c.cameraId === "string")
    .map((c) => ({ id: c.cameraId, name: (typeof c.name === "string" && c.name) || c.cameraId }));
}

async function loadDisplayLayouts() {
  const data = await api("GET", "/display-layouts");
  displayLayoutsData = (data && typeof data.displays === "object" && data.displays) || {};
  if (data && data.problem) showMessage(data.problem, "error");
}

/** A short, honest summary of one display's raw assignment -- never a bare
 *  camera count that hides a removed one: "3 assigned, 1 removed" is a
 *  different fact than "3 assigned". */
export function describeAssignment(existing) {
  if (!existing || !Array.isArray(existing.cells)) return "No layout assigned";
  const known = new Set(cameraOptions.map((c) => c.id));
  let assigned = 0;
  let removed = 0;
  for (const cell of existing.cells) {
    if (cell === null || cell === undefined) continue;
    if (known.has(cell)) assigned++;
    else removed++;
  }
  const parts = [`${existing.layout}`, `${assigned} camera${assigned === 1 ? "" : "s"} assigned`];
  if (removed > 0) parts.push(`${removed} removed`);
  return parts.join(" — ");
}

function renderDisplays(displays) {
  displayListEl.textContent = "";
  if (displays.length === 0) {
    const empty = document.createElement("p");
    empty.className = "dim";
    empty.textContent = "No wall displays yet.";
    displayListEl.append(empty);
    return;
  }
  for (const display of displays) {
    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("strong");
    name.textContent = display.displayId;
    row.append(name);

    const created = document.createElement("span");
    created.className = "dim";
    created.textContent = formatDate(display.createdUtc);
    row.append(created);

    const layoutSummary = document.createElement("span");
    layoutSummary.className = "dim";
    layoutSummary.textContent = describeAssignment(displayLayoutsData[display.displayId]);
    row.append(layoutSummary);

    const layoutButton = document.createElement("button");
    layoutButton.type = "button";
    layoutButton.textContent = "Layout";
    layoutButton.addEventListener("click", () => {
      run(() => openLayoutEditor(display.displayId));
    });
    row.append(layoutButton);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "danger";
    removeButton.textContent = "Remove";
    removeButton.addEventListener("click", () => {
      run(() => removeDisplay(display.displayId));
    });
    row.append(removeButton);

    displayListEl.append(row);
  }
}

/* ── display layout assignment (SITE-SETTINGS-SPEC.md section 3) ────────
 * "The installer (account.manage) assigns a display a layout: a shape plus
 * cameras." One editor, shared, for whichever display was clicked -- not
 * one editor per row, which would mean N camera lists live in the DOM at
 * once for a site with N displays. */

function cellOptionsFor(currentValue) {
  const select = document.createElement("select");
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "(empty)";
  select.append(empty);
  const known = new Set(cameraOptions.map((c) => c.id));
  for (const cam of cameraOptions) {
    const option = document.createElement("option");
    option.value = cam.id;
    // An installer-typed camera name: .textContent only.
    option.textContent = cam.name;
    select.append(option);
  }
  if (typeof currentValue === "string" && currentValue !== "" && !known.has(currentValue)) {
    // The saved cell names a camera that no longer exists -- shown, never
    // silently dropped to blank, so the installer can see and choose to
    // clear it (or leave it: the camera may come back).
    const removedOption = document.createElement("option");
    removedOption.value = currentValue;
    removedOption.textContent = `${currentValue} (camera removed)`;
    select.append(removedOption);
  }
  select.value = typeof currentValue === "string" ? currentValue : "";
  return select;
}

function rebuildLayoutCells(shapeId, existingCells) {
  displayLayoutCellsEl.textContent = "";
  const shape = GRID_SHAPES.find((s) => s.id === shapeId) || GRID_SHAPES[1];
  const cells = Array.isArray(existingCells) ? existingCells : [];
  for (let i = 0; i < shape.cells; i++) {
    const select = cellOptionsFor(cells[i]);
    const label = document.createElement("label");
    const tag = document.createElement("span");
    tag.textContent = `Cell ${i + 1}`;
    label.append(tag, select);
    displayLayoutCellsEl.append(label);
  }
}

function currentLayoutCellValues() {
  const labels = [...displayLayoutCellsEl.querySelectorAll("select")];
  return labels.map((s) => (s.value === "" ? null : s.value));
}

async function openLayoutEditor(displayId) {
  editingDisplayId = displayId;
  displayLayoutTitleEl.textContent = `Assign layout — ${displayId}`;
  displayLayoutErrorsEl.textContent = "";
  const existing = displayLayoutsData[displayId];
  const shapeId = existing && typeof existing.layout === "string" ? existing.layout : "2x2";
  displayLayoutShapeEl.value = shapeId;
  rebuildLayoutCells(shapeId, existing ? existing.cells : []);
  displayLayoutEditorEl.hidden = false;
}

function closeLayoutEditor() {
  editingDisplayId = null;
  displayLayoutEditorEl.hidden = true;
}

async function saveLayoutAssignment() {
  if (editingDisplayId === null) return;
  const cells = currentLayoutCellValues();
  displayLayoutErrorsEl.textContent = "";
  try {
    await api("POST", "/display-layouts", { displayId: editingDisplayId, layout: displayLayoutShapeEl.value, cells });
  } catch (err) {
    if (err instanceof RequestError) {
      displayLayoutErrorsEl.textContent = err.message;
      return;
    }
    throw err;
  }
  displayLayoutsData[editingDisplayId] = { layout: displayLayoutShapeEl.value, cells };
  showMessage(`Layout assigned to ${editingDisplayId}.`, "good");
  closeLayoutEditor();
  await loadDisplays();
}

async function removeAccount(username) {
  if (!window.confirm(`Remove ${username}? They are signed out at once.`)) return;
  await api("DELETE", `/accounts/${encodeURIComponent(username)}`);
  await loadAccounts();
  showMessage(`Removed ${username}.`, "good");
}

async function resetPassword(username) {
  const value = window.prompt(`New password for ${username} (12 characters or more)`);
  if (value === null || value === "") return;
  if ([...value].length < 12) {
    showMessage("That password is shorter than 12 characters. Nothing was changed.", "error");
    return;
  }
  await api("POST", `/accounts/${encodeURIComponent(username)}/password`, { password: value });
  showMessage(`Password reset. ${username} is signed out everywhere.`, "good");
}

async function addAccount() {
  const username = addUsernameEl.value.trim();
  const role = addRoleEl.value;
  const password = addPasswordEl.value;
  const confirmValue = addConfirmEl.value;
  if (password !== confirmValue) {
    showMessage("The passwords do not match.", "error");
    return;
  }
  addAccountButtonEl.disabled = true;
  try {
    await api("POST", "/accounts", { username: username, role: role, password: password });
    addAccountFormEl.reset();
    await loadAccounts();
    showMessage(`Created ${username}.`, "good");
  } finally {
    addAccountButtonEl.disabled = false;
  }
}

async function removeDisplay(displayId) {
  if (!window.confirm(`Remove display ${displayId}? It stops showing video at once.`)) return;
  await api("DELETE", `/displays/${encodeURIComponent(displayId)}`);
  await loadDisplays();
  showMessage(`Removed display ${displayId}.`, "good");
}

async function addDisplay() {
  const displayId = addDisplayIdEl.value.trim();
  addDisplayButtonEl.disabled = true;
  try {
    const data = await api("POST", "/displays", { displayId: displayId });
    newDisplayLinkEl.value = `${location.origin}/login#display=${data.token}`;
    newDisplayTokenEl.hidden = false;
    addDisplayIdEl.value = "";
    showMessage("Open this link once on the TV. It is shown only now.", "good");
  } finally {
    addDisplayButtonEl.disabled = false;
  }
}

function selectLinkText() {
  newDisplayLinkEl.focus();
  newDisplayLinkEl.select();
  try {
    newDisplayLinkEl.setSelectionRange(0, newDisplayLinkEl.value.length);
  } catch (err) {
    /* select() alone is enough where setSelectionRange is unavailable */
  }
}

function copyDisplayLink() {
  const text = newDisplayLinkEl.value;
  if (text === "") return;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(() => {
      showMessage("Link copied to the clipboard.", "good");
    }, () => {
      selectLinkText();
      showMessage("Could not copy automatically. The link is selected — copy it manually.", "error");
    });
  } else {
    selectLinkText();
  }
}

function dismissDisplayToken() {
  newDisplayLinkEl.value = "";
  newDisplayTokenEl.hidden = true;
}

async function signOut() {
  await api("POST", "/auth/logout", {});
  location.replace("/login");
}

async function init() {
  const state = await api("GET", "/auth/state");
  const principal = (state && state.principal) || {};
  if (principal.username) {
    signedInUsername = principal.username;
    whoamiEl.textContent = `Signed in as ${principal.username} (${principal.role})`;
  } else {
    whoamiEl.textContent = "Signed in";
  }
  // The camera list and every display's assignment load BEFORE loadDisplays
  // renders the display rows, since renderDisplays reads both synchronously
  // (describeAssignment, cellOptionsFor) -- rendering first would show every
  // row with a stale or blank summary for one frame, and on a slow link,
  // longer than that.
  await Promise.all([loadAccounts(), loadCameraOptions(), loadDisplayLayouts()]);
  await loadDisplays();
}

function populateShapeSelect() {
  for (const shape of GRID_SHAPES) {
    const option = document.createElement("option");
    option.value = shape.id;
    option.textContent = `${shape.id} (${shape.cells} cameras)`;
    displayLayoutShapeEl.append(option);
  }
}

function wireEvents() {
  signOutEl.addEventListener("click", () => {
    run(signOut);
  });
  addAccountFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    run(addAccount);
  });
  addDisplayFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    run(addDisplay);
  });
  copyDisplayLinkEl.addEventListener("click", copyDisplayLink);
  dismissDisplayTokenEl.addEventListener("click", dismissDisplayToken);
  populateShapeSelect();
  displayLayoutShapeEl.addEventListener("change", () => {
    // Best effort: cells that still fit the new shape keep their camera;
    // ones beyond its cell count are simply dropped, never silently
    // reassigned to a different index.
    const previous = currentLayoutCellValues();
    rebuildLayoutCells(displayLayoutShapeEl.value, previous);
  });
  displayLayoutSaveEl.addEventListener("click", () => {
    run(saveLayoutAssignment);
  });
  displayLayoutCancelEl.addEventListener("click", closeLayoutEditor);
}

async function start() {
  wireEvents();
  await run(init);
}

start();
