#!/usr/bin/env node
// The hub — the command centre window for the agent bus.
//
// SPLIT OUT OF server.mjs (stage 0, spec-hub-projects-and-routing.md). server.mjs
// keeps the bus: state, lock, MCP and the worker engine. This file owns
// everything a PERSON looks at: the dashboard page, its HTTP server, the
// workers started from the window, and the written-to-disk page snapshot.
//
// SPAWNED, NOT IMPORTED — same reasoning as context-cost.cjs. server.mjs is run
// once per Claude session as an MCP server, and a render bug in this file used
// to throw inside that process: every session in the repo loses its tool list
// at once. `server.mjs dashboard` now spawns this file as a child process, so
// the hub can die alone and the bus keeps answering.
//
// One dependency direction: this file imports the bus's exported surface from
// server.mjs. server.mjs never imports this file.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  DIR,
  PROJECT_ROOT,
  docsDir,
  askRunner,
  asActor,
  callTool,
  claimNextTask,
  describeLock,
  finishTask,
  findRunner,
  lockIsLive,
  pruneAgents,
  readRunners,
  registerCli,
  withState,
} from "./server.mjs";

const STATE = path.join(DIR, "state.json");
// Lives beside the state, not in the repo tree: it is generated, per-machine,
// and nobody should be tempted to commit it.
const STATUS_PAGE = path.join(DIR, "status.html");

/* ── the page snapshot ────────────────────────────────────────────────────── */

// THE PAGE, as a file rather than a server.
//
// Written beside the state so a browser tab left open on
// .git/agent-bus/status.html stays current with no command to run. Read-only:
// a file:// page has nothing to POST to, so the action forms are omitted rather
// than rendered dead.
//
// This file owns the snapshot's freshness: a watcher on the state file re-renders
// it whenever any process — MCP session, CLI call, this window — changes the bus.
// (Before the split this write happened inside withState() in server.mjs, which
// put render code in the MCP server; that is the failure mode this split removes.)
function writeStatusPage(state) {
  try {
    const tmp = `${STATUS_PAGE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, renderStatusHtml(state, { interactive: false }));
    fs.renameSync(tmp, STATUS_PAGE);
  } catch {
    // Never let the page break the bus. A failed write here is cosmetic; the
    // tools agents depend on must still return.
  }
}

let lastSeenMtimeMs = 0;

function refreshPage(force = false) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(STATE).mtimeMs;
  } catch {
    return; // no state yet — nothing to render
  }
  if (!force && mtimeMs === lastSeenMtimeMs) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return; // mid-rename or corrupt — the next tick re-renders
  }
  if (!state || typeof state !== "object") return;
  lastSeenMtimeMs = mtimeMs;
  writeStatusPage(state);
}

/* ── docs, read live ──────────────────────────────────────────────────────── */

/**
 * The build rules, read from docs/build-rules.md at render time.
 *
 * NOT copied into this file. The rules change as incidents happen — they are up
 * to 26 and were 12 — and a hub showing a stale copy of the rules would be
 * exactly the failure the rules exist to prevent. Where they live is
 * docsDir()'s answer (the project root's docs/ unless AGENT_BUS_DOCS_DIR
 * says otherwise).
 */
function readBuildRules() {
  try {
    const md = fs.readFileSync(path.join(docsDir(), "build-rules.md"), "utf8");
    const groups = [];
    let current = null;
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      // "## A. The shape of the work" — a group.
      const head = line.match(/^##\s+[A-Z]\.\s+(.+)$/);
      if (head) {
        current = { title: head[1], rules: [] };
        groups.push(current);
        continue;
      }
      // "### A1. Contract, then harness, then UI. In that order."
      const rule = line.match(/^###\s+([A-Z]\d+)\.\s+(.+)$/);
      if (rule && current) current.rules.push({ n: rule[1], text: rule[2] });
    }
    return groups.filter((g) => g.rules.length);
  } catch {
    return [];
  }
}

/**
 * The operating model, read from docs/how-we-work.md at render time.
 *
 * Live for the same reason the rules are: this describes how work is actually
 * split between the orchestrator, the implementing agents and the person, and a
 * hub showing last month's version of that is worse than showing none.
 * Sections are "## Heading" with "- " bullets under them.
 */
function readWorkflow() {
  try {
    const md = fs.readFileSync(path.join(docsDir(), "how-we-work.md"), "utf8");
    const groups = [];
    let current = null;
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      const head = line.match(/^##\s+(.+)$/);
      if (head) {
        current = { title: head[1], items: [] };
        groups.push(current);
        continue;
      }
      const item = line.match(/^-\s+(.+)$/);
      if (item && current) current.items.push(item[1]);
    }
    return groups.filter((g) => g.items.length);
  } catch {
    return [];
  }
}

/* ── workers you can start from the window ────────────────────────────────── */

// Workers run INSIDE the hub process rather than as spawned children.
//
// Two reasons. Spawning would mean tracking pids across a Windows/POSIX split
// and inheriting orphans when the hub dies — the same class of problem the
// working-tree lock already had to solve with kill(pid,0). And it matches what
// the window means to a person: the hub is open, so the agents are working; you
// close it, they stop. Nothing keeps running invisibly after the window is gone.
//
// The engine underneath (claimNextTask, askRunner, finishTask) is the bus's —
// imported from server.mjs. What lives HERE is the loop and its lifetime, which
// is bound to this window.
//
// Keyed by lane, because two workers on one lane would race for the same task.
// claimNextTask is atomic so it would be *safe*, but it would also be pointless.
const liveWorkers = new Map();

async function workerLoop(lane) {
  const entry = liveWorkers.get(lane);
  if (!entry) return;
  while (!entry.stop) {
    let task = null;
    try {
      task = claimNextTask(lane);
    } catch {
      // A locked state file is transient. Wait rather than killing the worker.
    }
    if (!task) {
      entry.status = "waiting";
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    entry.status = `running ${task.id}`;
    entry.lastTask = task.id;
    try {
      const runner = findRunner(task.runner_id || entry.runnerId);
      const answer = await askRunner(runner, task.prompt);
      finishTask(task.id, { status: "done", result: answer, model: runner.id });
      entry.done = (entry.done ?? 0) + 1;
    } catch (err) {
      finishTask(task.id, {
        status: "failed",
        result: err.message,
        model: task.runner_id || entry.runnerId,
      });
      entry.failed = (entry.failed ?? 0) + 1;
    }
  }
  liveWorkers.delete(lane);
}

function startLiveWorker(lane, runnerId) {
  if (liveWorkers.has(lane)) {
    return `A worker is already running on lane "${lane}". Stop it first.`;
  }
  // Resolve now, so a disabled or misspelled runner fails HERE with a message
  // on screen instead of silently on the first task.
  const runner = findRunner(runnerId);
  liveWorkers.set(lane, {
    lane,
    runnerId: runner.id,
    label: runner.label ?? runner.id,
    status: "waiting",
    startedAt: new Date().toISOString(),
    stop: false,
  });
  void workerLoop(lane);
  return `Worker started on "${lane}" using ${runner.label ?? runner.id}.`;
}

function stopLiveWorker(lane) {
  const entry = liveWorkers.get(lane);
  if (!entry) return `No worker running on "${lane}".`;
  entry.stop = true;
  entry.status = "stopping";
  // It finishes the task in hand rather than abandoning it half-done, so a
  // model call already in flight still gets its answer written back.
  return `Worker on "${lane}" will stop after its current task.`;
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function renderStatusHtml(state, opts = {}) {
  const { flash = null, interactive = false } = opts;
  pruneAgents(state);
  const now = Date.now();
  const ago = (iso) => {
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };
  // Everything below is text other processes wrote. All of it is escaped.
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

  const agents = Object.entries(state.agents).sort(
    (a, b) => Date.parse(b[1].lastSeen ?? 0) - Date.parse(a[1].lastSeen ?? 0)
  );
  const lock = state.lock;
  const held = lockIsLive(lock);
  const board = Object.entries(state.board).sort(
    (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
  );
  const repo = PROJECT_ROOT;

  const agentCards = agents.length
    ? agents
        .map(([name, a]) => {
          // Two minutes without a bus call reads as idle. Called "quiet", not
          // "offline": the bus cannot tell the difference and must not pretend.
          const quiet = now - Date.parse(a.lastSeen ?? 0) > 120_000;
          return `<div class="card${quiet ? " quiet" : ""}">
      <div class="row"><span class="dot"></span><b>${esc(name)}</b>
        <span class="mut">${esc(ago(a.lastSeen ?? new Date(0).toISOString()))}</span></div>
      <p class="lane">${esc(a.lane || "no lane stated")}</p>
      <p class="path">${esc(a.cwd || "")}</p>
    </div>`;
        })
        .join("")
    : "<p class=\"mut\">Nobody on the bus yet. An agent appears here after its first command.</p>";

  const boardRows = board.length
    ? board
        .map(
          ([k, v]) => `<details><summary><b>${esc(k)}</b>
      <span class="mut">${esc(v.by)} · ${esc(ago(v.at))}</span></summary>
      <p>${esc(v.value)}</p></details>`
        )
        .join("")
    : "<p class=\"mut\">The board is empty.</p>";

  const tasks = (state.tasks ?? []).slice(-12).reverse();
  const taskHtml = tasks.length
    ? tasks
        .map((t) => {
          const cls = t.status === "failed" ? " held" : "";
          const body = t.result
            ? `<p class="mut" style="white-space:pre-wrap">${esc(t.result.slice(0, 1200))}</p>`
            : `<p class="mut">${esc(t.prompt || "").slice(0, 200)}</p>`;
          return `<details class="lock${cls}"><summary><b>${esc(t.id)}</b>
            <span>${esc(t.title || "")}</span>
            <span class="mut">${esc(t.lane)} · ${esc(t.status)}${t.model ? " · " + esc(t.model) : ""}</span>
          </summary>${body}</details>`;
        })
        .join("")
    : "<p class=\"mut\">Nothing queued. Work added here is picked up by a running worker.</p>";

  const runnerOptions = readRunners()
    .map(
      (r) =>
        `<option value="${esc(r.id)}"${r.enabled ? "" : " disabled"}>${esc(
          r.label ?? r.id
        )}${r.enabled ? "" : " (not configured)"}</option>`
    )
    .join("");

  const workers = [...liveWorkers.values()];
  const workerHtml = workers.length
    ? workers
        .map(
          (w) => `<div class="card"><div class="row"><span class="dot"></span>
            <b>${esc(w.lane)}</b><span class="mut">${esc(w.status)}</span></div>
            <p class="lane">${esc(w.label)}</p>
            <p class="mut">${w.done ?? 0} done${w.failed ? `, ${w.failed} failed` : ""}</p>
            ${
              interactive
                ? `<form method="post"><input type="hidden" name="action" value="worker_stop">
                   <input type="hidden" name="lane" value="${esc(w.lane)}">
                   <button>Stop</button></form>`
                : ""
            }</div>`
        )
        .join("")
    : "<p class=\"mut\">No worker running. Start one below and queued work begins moving.</p>";

  // The message thread (Stage 1) — the last 30, newest LAST, so reading order
  // matches how it was written. Local time on the machine rendering the page;
  // the day is shown for anything not from today.
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString()
      : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString()}`;
  };
  const thread = (state.messages ?? []).slice(-30);
  const threadHtml = thread.length
    ? thread
        .map(
          (m) => `<div class="msg"><span class="mut">${esc(fmtWhen(m.at))}</span>
      <b>${esc(m.from)}</b> → <b>${esc(m.to)}</b>
      <p class="msgtext">${esc(m.text)}</p></div>`
        )
        .join("")
    : "<p class=\"mut\">No messages yet.</p>";
  // Recipients: all, plus every name the bus can currently address. The list is
  // re-rendered per request, so a freshly pruned name drops off on its own.
  const recipientOptions = agents.length
    ? agents.map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")
    : "";

  const workGroups = readWorkflow();
  const workHtml = workGroups.length
    ? workGroups
        .map(
          (g) => `<div class="rulegroup"><h3>${esc(g.title)}</h3><ul>${g.items
            .map((i) => `<li>${esc(i.replace(/[`*]/g, ""))}</li>`)
            .join("")}</ul></div>`
        )
        .join("")
    : "<p class=\"mut\">docs/how-we-work.md not found from here.</p>";

  const ruleGroups = readBuildRules();
  const ruleHtml = ruleGroups.length
    ? ruleGroups
        .map(
          (g) => `<div class="rulegroup"><h3>${esc(g.title)}</h3><ul>${g.rules
            .map((r) => `<li><b>${esc(r.n)}</b> ${esc(r.text.replace(/[`*]/g, ""))}</li>`)
            .join("")}</ul></div>`
        )
        .join("")
    : "<p class=\"mut\">docs/build-rules.md not found from here.</p>";

  // Forms only exist in the served app. The written-to-disk copy is a file://
  // page with nothing to POST to, and a dead button is worse than no button.
  const actions = interactive
    ? `
<h2>Do something</h2>
<div class="grid2">
  <form method="post" class="card">
    <b>Post a note to the board</b>
    <p class="mut">Durable. Reaches agents who were not listening when you wrote it.</p>
    <input type="hidden" name="action" value="note">
    <input name="actor" placeholder="from (default: desk)" value="desk">
    <input name="key" placeholder="key, e.g. table-pattern" required>
    <textarea name="value" rows="3" placeholder="the fact, written for someone who was not here" required></textarea>
    <button>Post note</button>
  </form>

  <form method="post" class="card">
    <b>Send a message</b>
    <p class="mut">Only reaches an agent that is listening now. Use a note for anything that must outlive the moment.</p>
    <input type="hidden" name="action" value="send">
    <input name="actor" placeholder="from (default: desk)" value="desk">
    <input name="to" placeholder="to — an agent name, or all" required>
    <textarea name="message" rows="3" placeholder="message" required></textarea>
    <button>Send</button>
  </form>

  <form method="post" class="card">
    <b>${held ? "Release the working tree" : "Claim the working tree"}</b>
    <p class="mut">${
      held
        ? "Only the holder can release it."
        : "Claim before any git operation in a shared checkout."
    }</p>
    <input type="hidden" name="action" value="${held ? "release" : "claim"}">
    <input name="actor" placeholder="your name" value="${esc(held && lock ? lock.holder : "desk")}">
    ${
      held
        ? ""
        : `<input name="path" placeholder="path" value="${esc(repo)}" required>
    <input name="reason" placeholder="what you are doing" required>
    <input name="minutes" placeholder="minutes (default 30)" value="30">`
    }
    <button>${held ? "Release" : "Claim"}</button>
  </form>
</div>`
    : `<h2>Do something</h2>
<p class="mut">This is the saved copy of the page — read-only. Launch <b>Agent Bus</b>
from the desktop to run commands.</p>`;

  return `<!doctype html>
<meta charset="utf-8"><title>Agent Bus — command hub</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${interactive ? "" : '<meta http-equiv="refresh" content="5">'}
<style>
  :root { color-scheme: light dark; --bg:#f6f7f5; --fg:#16201a; --mut:#5d6b5f;
    --card:#fff; --line:#dfe4dc; --ok:#2f6b3f; --warn:#b4530a; --code:#eef1ec; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#11150f; --fg:#e4ebe2; --mut:#93a094; --card:#181e16; --line:#2a3329;
    --code:#1e2620; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:26px 30px 60px; background:var(--bg); color:var(--fg);
    font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  h1 { font-size:16px; margin:0; letter-spacing:.02em; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.09em;
    color:var(--mut); margin:30px 0 9px; font-weight:600; }
  h3 { font-size:12px; margin:0 0 6px; }
  .mut { color:var(--mut); font-size:12px; margin:4px 0 0; }
  .grid { display:grid; gap:8px; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); }
  .grid2 { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card.quiet { opacity:.5; }
  .row { display:flex; align-items:center; gap:7px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:0 0 auto; }
  .quiet .dot { background:var(--mut); }
  .row .mut { margin-left:auto; }
  .lane { margin:6px 0 0; }
  .path { margin:3px 0 0; color:var(--mut); font-size:11px;
    overflow-wrap:anywhere; font-family:ui-monospace,monospace; }
  .lock { background:var(--card); border:1px solid var(--line);
    border-left:3px solid var(--ok); border-radius:10px; padding:12px 14px; }
  .lock.held { border-left-color:var(--warn); }
  details { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:10px 14px; margin-bottom:6px; }
  summary { cursor:pointer; display:flex; gap:8px; align-items:center; }
  details p { margin:9px 0 2px; color:var(--mut); overflow-wrap:anywhere; }
  input, textarea, select { width:100%; margin-top:7px; padding:7px 9px; border-radius:7px;
    border:1px solid var(--line); background:var(--bg); color:var(--fg); font:inherit; font-size:13px; }
  textarea { resize:vertical; }
  button { margin-top:9px; padding:7px 14px; border-radius:7px; border:0;
    background:var(--ok); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  pre { background:var(--code); border:1px solid var(--line); border-radius:8px;
    padding:9px 11px; overflow-x:auto; font-size:12px; margin:6px 0 0; }
  .flash { background:var(--card); border:1px solid var(--ok); border-left:3px solid var(--ok);
    border-radius:9px; padding:10px 13px; margin:14px 0 0; white-space:pre-wrap; font-size:13px; }
  .rulegroup { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:12px 14px; }
  .msg { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:8px 12px; margin-bottom:6px; }
  .msg .mut { margin:0 6px 0 0; font-size:11px; }
  .msgtext { margin:5px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--fg); }
  .thread { max-height:420px; overflow-y:auto; }
  .rulegroup ul { margin:0; padding-left:0; list-style:none; }
  .rulegroup li { margin:3px 0; color:var(--mut); }
  .head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
</style>

<div class="head">
  <h1>Agent Bus</h1>
  <span class="mut">command hub · ${esc(new Date().toLocaleTimeString())}</span>
</div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}

<h2>Connected (${agents.length})</h2>
<div class="grid">${agentCards}</div>

<h2>Working tree</h2>
<div class="lock${held ? " held" : ""}">${esc(describeLock(lock))}</div>
${actions}

<h2>Workers (${workers.length})</h2>
<div class="grid">${workerHtml}</div>
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Start a worker</b>
    <p class="mut">It runs while this window is open and takes queued work in its lane.</p>
    <input type="hidden" name="action" value="worker_start">
    <input name="lane" placeholder="lane" value="local">
    <select name="runner_id">${runnerOptions}</select>
    <button>Start</button>
  </form>`
    : ""
}

<h2>Talk to the agents</h2>
<p class="mut">A noticeboard, not chat — an agent reads your message at its next
  <code>inbox()</code> call. A session already running will not notice until it looks.
  For a fact the NEXT agent needs even if nobody is listening, post a note to the board instead.</p>
<div class="thread">${threadHtml}</div>
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Write to the agents</b>
    <input type="hidden" name="action" value="message">
    <select name="to"><option value="all">all</option>${recipientOptions}</select>
    <textarea name="text" rows="3" placeholder="the message" required></textarea>
    <button>Post it</button>
  </form>`
    : ""
}

<h2>Work queue (${tasks.length})</h2>
<p class="mut">Queued work is executed by a worker, not by a person reading this.
  Start one above and pick which agent runs it — it takes the
  next queued task in its lane, runs it against the local model, and writes the answer
  back here. Output is a DRAFT: the worker never touches the repo.</p>
${taskHtml}
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Queue work</b>
    <input type="hidden" name="action" value="task">
    <input name="actor" placeholder="from (default: desk)" value="desk">
    <input name="lane" placeholder="lane" value="local">
    <select name="runner_id">${runnerOptions}</select>
    <input name="title" placeholder="short title" required>
    <textarea name="prompt" rows="3" placeholder="the whole task, written for someone with no context" required></textarea>
    <button>Queue it</button>
  </form>`
    : ""
}

<h2>Board (${board.length})</h2>
${boardRows}

<h2>Connect another AI</h2>
<div class="grid2">
  <div class="card">
    <b>Anything that can run a command</b>
    <p class="mut">A PowerShell session, an ollama-driven script, a person at a terminal.
      No install, no MCP. Run it from the repo.</p>
    <pre>cd ${esc(repo)}
node tools/agent-bus/server.mjs board
node tools/agent-bus/server.mjs note my-status "what I am doing"</pre>
    <p class="mut">Set a name once so you do not pass it every time:</p>
    <pre>$env:AGENT_BUS_NAME = "your-agent-name"</pre>
  </div>
  <div class="card">
    <b>A Claude session</b>
    <p class="mut">Already wired — <code>.mcp.json</code> in the repo root starts the bus
      as an MCP server, so the tools appear on their own. Nothing to do.</p>
    <pre>{ "mcpServers": { "agent-bus": {
    "command": "node",
    "args": ["tools/agent-bus/server.mjs"] } } }</pre>
    <p class="mut">First call should be <code>register(name, lane)</code>, then
      <code>board()</code>.</p>
  </div>
</div>
<p class="mut">Running <code>server.mjs</code> with no arguments starts the stdio MCP
  server and blocks — that is for editors, not for you. Any verb prints usage.</p>

<h2>How we work</h2>
<p class="mut">The operating model, read live from <code>docs/how-we-work.md</code>.
  The expensive model plans and verifies, cheaper agents implement, and this board is
  how they stay out of each other's way.</p>
<div class="grid2">${workHtml}</div>

<h2>How to build here — ${ruleGroups.reduce((n, g) => n + g.rules.length, 0)} rules</h2>
<p class="mut">Read live from <code>docs/build-rules.md</code>. Every one was written after
  something went wrong; the reasoning and the incident behind each is in that file.</p>
<div class="grid2">${ruleHtml}</div>
`;
}

function dashboardHtml(flash) {
  return withState((state) => renderStatusHtml(state, { flash, interactive: true }));
}

/**
 * Run one action on behalf of the person at the window.
 *
 * The web UI has no session of its own, so it borrows an identity for the
 * length of the call the same way the CLI does. `actor` defaults to "desk" so
 * anything done from the app is attributable to the desk rather than appearing
 * to come from whichever agent happened to be listed first.
 *
 * The borrow itself (myName / IS_CLI) is the bus's module state, so it goes
 * through asActor() rather than reaching into server.mjs internals.
 */
function runAction(action, form) {
  const actor = (form.get("actor") || "desk").trim() || "desk";
  // A browser POST is as short-lived as a CLI call: no pid to trust.
  return asActor(actor, () => {
    registerCli(actor);
    switch (action) {
      case "note":
        return callTool("note", { key: form.get("key"), value: form.get("value") });
      case "send":
        return callTool("send", { to: form.get("to"), message: form.get("message") });
      case "message":
        // Stage 1 — the person writes as "human", bypassing send's requireName.
        return postFromWindow(form.get("to"), form.get("text"));
      case "claim":
        return callTool("claim_tree", {
          path: form.get("path"),
          reason: form.get("reason"),
          minutes: Number(form.get("minutes")) || 30,
        });
      case "release":
        return callTool("release_tree", {});
      case "worker_start":
        return startLiveWorker(form.get("lane") || "local", form.get("runner_id"));
      case "worker_stop":
        return stopLiveWorker(form.get("lane"));
      case "task":
        return callTool("task_add", {
          lane: form.get("lane") || "local",
          runner_id: form.get("runner_id") || null,
          title: form.get("title"),
          prompt: form.get("prompt"),
        });
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  });
}

/**
 * Post a message on behalf of the person at the window (Stage 1).
 *
 * Deliberately NOT routed through the send tool: send() calls requireName(),
 * and the hub is not a registered agent — the person at the desk is nobody the
 * bus has a session for. The write happens inside withState() directly, with
 * the same 500-entry cap. `from` is "human": the desk speaks as itself, not by
 * borrowing another agent's identity.
 *
 * A broadcast to `all` works when nobody is registered — the normal case when
 * the window is opened first. A NAMED recipient must still exist: the dropdown
 * only offers live names, but an agent an hour cold is pruned between
 * rendering the form and posting, and a message addressed to nobody would
 * silently never be read.
 */
function postFromWindow(to, text) {
  const toName = String(to || "").trim();
  const body = String(text || "").trim();
  if (!toName) throw new Error("A recipient is required.");
  if (!body) throw new Error("The message needs text.");
  return withState((state) => {
    if (toName !== "all" && !state.agents[toName]) {
      throw new Error(
        `No agent named "${toName}" is registered. Active: ${Object.keys(state.agents).join(", ") || "none"}.`
      );
    }
    state.messages.push({
      id: randomUUID(),
      from: "human",
      to: toName,
      text: body,
      at: new Date().toISOString(),
      readBy: [],
    });
    // Keep the log bounded; this is a bus, not an archive.
    if (state.messages.length > 500) state.messages = state.messages.slice(-500);
    return toName === "all"
      ? "Posted to all. Agents see it at their next inbox() call."
      : `Posted to ${toName}. They see it at their next inbox() call.`;
  });
}

/* ── the HTTP server ──────────────────────────────────────────────────────── */

// A page, because a status line you have to remember to run is not the same as
// a window you leave open on a second monitor.
//
// SERVED LOCALLY, and it has to be: the bus state is a JSON file in this repo's
// .git directory. Nothing hosted could read it, so this renders on each request
// from the same withState() the tools use — no cache, no sync, no way for the
// page to disagree with the bus.
//
// Server-rendered with a meta refresh rather than client-side polling. It is a
// status board on a local socket; five lines of HTML beat a fetch loop, and it
// keeps the no-dependencies rule the bus has kept from the start.
function runDashboard(port) {
  // Imported here, not at the top: the page snapshot watcher below is the only
  // thing that needs it before a request arrives.
  return import("node:http").then(({ default: http }) => {
    const server = http.createServer((req, res) => {
      try {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
            // A form post is a few hundred bytes. Anything much larger is not
            // this UI, and an unbounded read on a local socket is how a tiny
            // server becomes a memory bug.
            if (body.length > 64_000) req.destroy();
          });
          req.on("end", () => {
            const form = new URLSearchParams(body);
            let flash;
            try {
              flash = runAction(form.get("action"), form);
            } catch (err) {
              flash = `FAILED: ${err.message}`;
            }
            // POST-then-redirect, so a refresh does not repeat the action.
            res.writeHead(303, {
              location: `/?flash=${encodeURIComponent(String(flash).slice(0, 400))}`,
            });
            res.end();
          });
          return;
        }
        const url = new URL(req.url, "http://127.0.0.1");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml(url.searchParams.get("flash")));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err.message));
      }
    });
    // Loopback only. This exposes who is working on what and where their
    // worktrees are; it is for the machine it runs on.
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`agent-bus dashboard: http://127.0.0.1:${port}\n`);
      process.stdout.write("Ctrl+C to stop.\n");
    });
    server.on("error", (err) => {
      process.stdout.write(
        err.code === "EADDRINUSE"
          ? `Port ${port} is busy — try: node server.mjs dashboard ${port + 1}\n`
          : `dashboard failed: ${err.message}\n`
      );
      process.exitCode = 1;
    });

    // Keep the written-to-disk page current while this window is open. Every
    // process that changes the bus rewrites state.json; this picks the change
    // up within a second, whichever process made it.
    refreshPage(true);
    fs.watchFile(STATE, { interval: 1000 }, () => refreshPage());
  });
}

/* ── entrypoint ───────────────────────────────────────────────────────────── */

// A module, not a running hub, when imported — though nothing imports this
// file: server.mjs spawns it precisely so it cannot.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDashboard(Number(process.argv[2]) || 7777);
}