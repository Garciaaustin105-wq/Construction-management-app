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

let signedInUsername = null;

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
  await Promise.all([loadAccounts(), loadDisplays()]);
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
}

async function start() {
  wireEvents();
  await run(init);
}

start();
