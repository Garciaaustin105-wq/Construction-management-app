// agent/ui/login-client.mjs — served as /ui/login-client.js
//
// Talks to /auth/state, /auth/login, /auth/activate and /auth/display. Where
// to go afterwards is the server's decision (/login?next= goes through
// safeNext on the next load of /login), so this file never follows a URL it
// was handed: it reloads /login with the same query and lets the server
// redirect a signed-in browser to a page of its own.

const $ = (id) => document.getElementById(id);

function show(id) {
  for (const s of ["signIn", "activate", "pairing", "locked"]) $(s).hidden = s !== id;
}

function say(text, bad = true) {
  $("message").textContent = text;
  $("message").className = bad ? "bad" : "dim";
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // an empty or non-JSON body is reported by status below
  }
  return { status: res.status, json };
}

/** Signed in: reload /login so the server picks the destination. */
const done = () => location.replace("/login" + location.search);

function refusal({ status, json }) {
  if (status === 429) return json?.message ?? "Too many attempts. Wait and try again.";
  return json?.message ?? `The recorder refused (${status}).`;
}

async function withButton(button, work) {
  button.disabled = true;
  try {
    await work();
  } catch {
    say("Could not reach the recorder.");
  } finally {
    button.disabled = false;
  }
}

async function pairDisplay(token) {
  show("pairing");
  // Out of the address bar and history before anything else can read it.
  history.replaceState(null, "", "/login");
  const r = await post("/auth/display", { token });
  if (r.status === 200) {
    location.replace("/");
    return;
  }
  say(refusal(r));
}

async function start() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("display");
  if (token) {
    await pairDisplay(token);
    return;
  }

  let state;
  try {
    const res = await fetch("/auth/state", { credentials: "same-origin" });
    if (res.status === 503) {
      show("locked");
      return;
    }
    state = await res.json();
  } catch {
    say("Could not reach the recorder.");
    return;
  }

  if (state.needsActivation) {
    show("activate");
    $("codeLabel").hidden = !state.activationNeedsCode;
    $("code").required = state.activationNeedsCode;
    $("activateForm").addEventListener("submit", (e) => {
      e.preventDefault();
      if ($("newPassword").value !== $("confirmPassword").value) {
        say("The passwords do not match.");
        return;
      }
      withButton($("activateButton"), async () => {
        const r = await post("/auth/activate", {
          code: $("code").value,
          username: $("newUsername").value,
          password: $("newPassword").value,
        });
        if (r.status === 200) done();
        else say(refusal(r));
      });
    });
    $("code").focus();
    return;
  }

  show("signIn");
  $("signInForm").addEventListener("submit", (e) => {
    e.preventDefault();
    withButton($("signInButton"), async () => {
      const r = await post("/auth/login", { username: $("username").value, password: $("password").value });
      if (r.status === 200) {
        done();
        return;
      }
      $("password").value = "";
      $("password").focus();
      say(refusal(r));
    });
  });
  $("username").focus();
}

start();
