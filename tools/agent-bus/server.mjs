#!/usr/bin/env node
// agent-bus — a coordination bus for the Claude sessions working in this repo.
//
// WHY THIS EXISTS: several agents run at once here, across a shared checkout and
// thirteen worktrees. Two things kept going wrong and neither was fixable by
// talking more:
//
//   1. Two sessions used the same working tree and switched branches under each
//      other mid-edit.
//   2. A lane spec went stale between being WRITTEN and being READ, four times.
//      Nobody was talking at the moment it went stale, so no message could have
//      caught it. The fact has to outlive the conversation.
//
// So this is a LOCK plus a NOTICEBOARD, with messaging as the smaller third
// feature. A tool in the tool list gets used; a convention in a doc gets
// skipped, which is the whole reason this is an MCP server and not a README.
//
// No dependencies, on purpose: raw JSON-RPC over stdio. Adding a package here
// would mean editing package.json, which other agents have open.
//
// STATE LIVES IN THE GIT COMMON DIR. Every worktree has its own working
// directory, so a relative path would give thirteen separate buses — worse than
// none. `git rev-parse --git-common-dir` resolves to the MAIN repo's .git from
// inside any worktree, so all agents agree on one location without configuring
// anything.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const VERSION = "1.0.0";
const PROTOCOL = "2024-11-05";

/* ── where state lives ────────────────────────────────────────────────────── */

function stateDir() {
  let base;
  try {
    // Resolves to the main repo's .git from inside any worktree — the whole
    // reason worktrees share one bus.
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    base = path.resolve(process.cwd(), common);
  } catch {
    // Not a git checkout. Fall back to a temp dir so the server still runs
    // rather than dying and taking the session's tool list with it.
    base = path.join(process.env.TEMP || process.env.TMPDIR || ".", "agent-bus-fallback");
  }
  const dir = path.join(base, "agent-bus");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DIR = stateDir();
const STATE = path.join(DIR, "state.json");
const LOCK = path.join(DIR, ".lock");
// Lives beside the state, not in the repo tree: it is generated, per-machine,
// and nobody should be tempted to commit it.
const STATUS_PAGE = path.join(DIR, "status.html");

/* ── atomic state access ──────────────────────────────────────────────────── */

// Node has no sleep; Atomics.wait on a throwaway buffer blocks without spinning
// the CPU, which matters because this process is otherwise idle.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` against the state file while holding an exclusive lock.
 *
 * `openSync(..., "wx")` is an ATOMIC exclusive create on both Windows and
 * POSIX. Without that atomicity two agents claim the tree in the same
 * millisecond and we are back where we started, except now with a file that
 * says everything is fine.
 */
function withState(fn) {
  let fd = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      fd = fs.openSync(LOCK, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // A session that crashed holding the lock must not deadlock the others.
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK);
          continue;
        }
      } catch {
        /* someone else just removed it; retry */
      }
      sleepMs(15);
    }
  }
  if (fd === null) throw new Error("agent-bus: could not acquire the state lock");

  try {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    } catch {
      state = null;
    }
    if (!state || typeof state !== "object") {
      state = { agents: {}, lock: null, messages: [], board: {} };
    }
    state.agents ||= {};
    state.messages ||= [];
    state.board ||= {};

    const result = fn(state);

    // Write-then-rename, so a reader never sees a half-written file.
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE);
    // Refresh the page every time the bus changes, so an open browser tab is
    // never behind the tools. Defined below; hoisting makes that fine.
    writeStatusPage(state);
    return result;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(LOCK); } catch { /* already gone */ }
  }
}

/* ── identity ─────────────────────────────────────────────────────────────── */

// One server process is spawned per session, so the process IS the session.
const SESSION_KEY = randomUUID();
let myName = null;
// A CLI invocation exits the instant it finishes, so its pid is dead by the next
// command. Recording it would make every CLI claim look abandoned and stealable
// — which is exactly what the smoke test caught. CLI claims fall back to the
// TTL instead; a shell script cannot be probed for liveness the way a
// long-running server process can.
let IS_CLI = false;

function requireName() {
  if (!myName) {
    throw new Error(
      "Call register(name) first so other agents know who you are."
    );
  }
  return myName;
}

const nowIso = () => new Date().toISOString();

function pruneAgents(state) {
  // An agent that has not been seen for an hour is gone. Its name frees up so a
  // restarted session can take it back.
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [name, a] of Object.entries(state.agents)) {
    if (Date.parse(a.lastSeen ?? 0) < cutoff) delete state.agents[name];
  }
}

function touch(state) {
  if (myName && state.agents[myName]) {
    state.agents[myName].lastSeen = nowIso();
  }
}

/**
 * Is the holding process still alive?
 *
 * One server process is spawned per session, so the process IS the session.
 * `kill(pid, 0)` sends no signal — it just asks the OS whether that pid exists,
 * and works on Windows and POSIX alike. This is EXACT where a heartbeat would
 * only be a guess: a crashed agent and a busy one look identical from outside,
 * so anything time-based either deadlocks on a crash or steals from an agent
 * that is mid-rebase.
 */
function holderAlive(lock) {
  if (!lock || typeof lock.holderPid !== "number") return true; // pre-1.1 lock, trust the TTL
  if (lock.holderPid === process.pid) return true;
  try {
    process.kill(lock.holderPid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err.code === "EPERM";
  }
}

function lockIsLive(lock) {
  if (!lock) return false;
  if (Date.parse(lock.expiresAt) <= Date.now()) return false;
  // The TTL is a courtesy cap; process liveness is the real check.
  return holderAlive(lock);
}

function describeLock(lock) {
  if (!lockIsLive(lock)) return "The working tree is free.";
  const mins = Math.max(0, Math.round((Date.parse(lock.expiresAt) - Date.now()) / 60000));
  return `HELD by ${lock.holder} — ${lock.reason} (${lock.path}), expires in ~${mins} min.`;
}

/* ── tools ────────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "register",
    description:
      "Claim a name on the bus so other agents can address you. Call this once at the start of a session, before any other bus tool. Say which lane or task you are on — that is what other agents see when they check who is active.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short handle, e.g. 'lane-d' or 'opus-desktop'." },
        lane: { type: "string", description: "What you are working on." },
      },
      required: ["name"],
    },
  },
  {
    name: "agents",
    description:
      "Who else is active, what they are working on, and who currently holds the working tree. Check this before you touch a shared checkout.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "claim_tree",
    description:
      "Take an exclusive claim on a working directory before running git checkout, stash, rebase or commit in it. Refuses and names the current holder if someone else has it. ALWAYS claim before switching branches in a shared checkout — that is the failure this bus exists to stop.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the working tree." },
        reason: { type: "string", description: "What you are about to do, in a few words." },
        minutes: {
          type: "number",
          description: "How long you expect to need it. Default 30, max 240. The claim expires on its own so a crashed session cannot deadlock everyone.",
        },
      },
      required: ["path", "reason"],
    },
  },
  {
    name: "release_tree",
    description: "Give back a working-tree claim as soon as you are done. Do not hold it while idle.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send",
    description:
      "Send a message to another agent by name, or to 'all'. Use it for things that need a reply. Anything another agent will need LATER — a landed change, a moved pattern — belongs in note() instead, because a message only reaches whoever is listening now.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "A registered agent name, or 'all'." },
        message: { type: "string" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "inbox",
    description:
      "Read messages addressed to you and mark them read. Call this at the start of a turn and before any git operation — this bus cannot push, so you only see messages when you look.",
    inputSchema: {
      type: "object",
      properties: {
        include_read: { type: "boolean", description: "Also show messages already read. Default false." },
      },
    },
  },
  {
    name: "note",
    description:
      "Post a durable fact to the noticeboard, keyed so it can be overwritten as things change. This is for what the NEXT agent needs to know regardless of whether they were listening: 'the table pattern moved to DataTable', 'Lane C already ships ComponentsPanel'. Four stale-spec incidents in this repo happened because facts like these lived only in a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Stable key, e.g. 'table-pattern' or 'lane-c-status'." },
        value: { type: "string", description: "The fact. Write it for someone who was not here." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "board",
    description:
      "Read the noticeboard — every durable fact posted by any agent, newest first. Read this BEFORE acting on a spec or handoff doc: the doc may have been written before the fact was posted.",
    inputSchema: { type: "object", properties: {} },
  },
];

function callTool(name, args) {
  switch (name) {
    case "register": {
      const wanted = String(args.name || "").trim();
      if (!wanted) throw new Error("A name is required.");
      return withState((state) => {
        pruneAgents(state);
        const existing = state.agents[wanted];
        if (existing && existing.sessionKey !== SESSION_KEY) {
          const age = Date.now() - Date.parse(existing.lastSeen ?? 0);
          if (age < 60 * 60 * 1000) {
            throw new Error(
              `"${wanted}" is already registered by another live session (last seen ${Math.round(age / 1000)}s ago). Pick a different name.`
            );
          }
        }
        myName = wanted;
        state.agents[wanted] = {
          sessionKey: SESSION_KEY,
          lane: args.lane ? String(args.lane) : null,
          cwd: process.cwd(),
          registeredAt: nowIso(),
          lastSeen: nowIso(),
        };
        const others = Object.keys(state.agents).filter((n) => n !== wanted);
        return [
          `Registered as "${wanted}".`,
          others.length ? `Also active: ${others.join(", ")}.` : "No other agents are registered.",
          describeLock(state.lock),
          "Read board() before acting on any spec, and inbox() before touching git.",
        ].join("\n");
      });
    }

    case "agents":
      return withState((state) => {
        pruneAgents(state);
        touch(state);
        const rows = Object.entries(state.agents).map(([n, a]) => {
          const mine = a.sessionKey === SESSION_KEY ? " (you)" : "";
          return `  ${n}${mine} — ${a.lane || "no lane stated"}\n    ${a.cwd}`;
        });
        return [
          rows.length ? "Active agents:\n" + rows.join("\n") : "No agents registered.",
          "",
          describeLock(state.lock),
        ].join("\n");
      });

    case "claim_tree": {
      const target = String(args.path || "").trim();
      const reason = String(args.reason || "").trim();
      if (!target) throw new Error("A path is required.");
      const minutes = Math.min(240, Math.max(1, Number(args.minutes) || 30));
      return withState((state) => {
        const me = requireName();
        touch(state);
        if (lockIsLive(state.lock) && state.lock.holder !== me) {
          // Refuse rather than steal. The holder may be mid-edit with
          // uncommitted work.
          throw new Error(
            `REFUSED — ${describeLock(state.lock)}\nAsk them with send(), or wait. Do not run checkout, stash or rebase there.`
          );
        }
        state.lock = {
          path: target,
          holder: me,
          holderPid: IS_CLI ? null : process.pid,
          reason,
          claimedAt: nowIso(),
          expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
        };
        return `Claimed ${target} for ${minutes} min — "${reason}". Call release_tree() as soon as you are done.`;
      });
    }

    case "release_tree":
      return withState((state) => {
        const me = requireName();
        touch(state);
        if (!lockIsLive(state.lock)) return "Nothing to release; the tree was already free.";
        if (state.lock.holder !== me) {
          throw new Error(`Not yours to release — ${describeLock(state.lock)}`);
        }
        const was = state.lock.path;
        state.lock = null;
        return `Released ${was}.`;
      });

    case "send": {
      const to = String(args.to || "").trim();
      const text = String(args.message || "");
      if (!to || !text) throw new Error("Both `to` and `message` are required.");
      return withState((state) => {
        const me = requireName();
        touch(state);
        if (to !== "all" && !state.agents[to]) {
          throw new Error(
            `No agent named "${to}" is registered. Active: ${Object.keys(state.agents).join(", ") || "none"}.`
          );
        }
        state.messages.push({
          id: randomUUID(),
          from: me,
          to,
          text,
          at: nowIso(),
          readBy: [],
        });
        // Keep the log bounded; this is a bus, not an archive.
        if (state.messages.length > 500) state.messages = state.messages.slice(-500);
        return to === "all"
          ? "Broadcast sent. Agents see it when they next call inbox()."
          : `Sent to ${to}. They see it when they next call inbox().`;
      });
    }

    case "inbox":
      return withState((state) => {
        const me = requireName();
        touch(state);
        const includeRead = args.include_read === true;
        // Messages sent before you arrived are not yours. A broadcast is a
        // conversation, not a backlog — if a fact needs to reach whoever comes
        // next, it belongs on the board.
        const since = Date.parse(state.agents[me]?.registeredAt ?? 0);
        const mine = state.messages.filter(
          (m) =>
            (m.to === me || m.to === "all") &&
            m.from !== me &&
            Date.parse(m.at) >= since
        );
        const show = includeRead ? mine : mine.filter((m) => !m.readBy.includes(me));
        for (const m of mine) if (!m.readBy.includes(me)) m.readBy.push(me);
        if (!show.length) return "No new messages.";
        return show
          .map((m) => `[${m.at}] from ${m.from}${m.to === "all" ? " (broadcast)" : ""}:\n${m.text}`)
          .join("\n\n");
      });

    case "note": {
      const key = String(args.key || "").trim();
      const value = String(args.value || "").trim();
      if (!key || !value) throw new Error("Both `key` and `value` are required.");
      return withState((state) => {
        const me = requireName();
        touch(state);
        const prior = state.board[key];
        state.board[key] = { value, by: me, at: nowIso() };
        return prior
          ? `Updated "${key}" (was set by ${prior.by}).`
          : `Posted "${key}" to the board.`;
      });
    }

    // Everything at a glance. `agents` answers who is here and `board` answers
    // what they left behind; needing both to know the state of the bus is what
    // made it confusing to look at.
    case "status":
      return withState((state) => {
        pruneAgents(state);
        touch(state);
        const now = Date.now();
        const ago = (iso) => {
          const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
          if (secs < 60) return `${secs}s ago`;
          if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
          return `${Math.round(secs / 3600)}h ago`;
        };
        const agents = Object.entries(state.agents);
        const lines = ["CONNECTED"];
        if (!agents.length) {
          lines.push("  nobody — an agent appears here after its first bus command");
        } else {
          for (const [n, a] of agents) {
            const mine = a.sessionKey === SESSION_KEY ? "  <- you" : "";
            // lastSeen is refreshed by touch() on every bus call, and
            // pruneAgents drops anyone an hour cold — so this is the honest
            // answer to "is that one still there?" rather than a guess.
            const seen = a.lastSeen ? ago(a.lastSeen) : "unknown";
            lines.push(`  ${n}${mine}`);
            lines.push(`     ${a.lane || "no lane stated"}`);
            lines.push(`     last seen ${seen}`);
          }
        }
        lines.push("", "WORKING TREE", "  " + describeLock(state.lock));
        const board = Object.entries(state.board).sort(
          (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
        );
        lines.push("", `BOARD (${board.length})`);
        if (!board.length) lines.push("  empty");
        for (const [k, v] of board) {
          // Keys and authors only. The values are paragraphs; `board` prints
          // those in full and this is meant to fit on one screen.
          lines.push(`  ${k} — ${v.by}, ${ago(v.at)}`);
        }
        if (board.length) lines.push("", "  full text: node server.mjs board");
        return lines.join("\n");
      });

    case "board":
      return withState((state) => {
        touch(state);
        const entries = Object.entries(state.board).sort(
          (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
        );
        if (!entries.length) return "The board is empty.";
        return entries
          .map(([k, v]) => `${k} — ${v.by}, ${v.at}\n  ${v.value}`)
          .join("\n\n");
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ── CLI mode ─────────────────────────────────────────────────────────────── */

// Anything that can run a command can join the bus — a PowerShell session, an
// ollama-driven script, a person at a terminal. Only Claude sessions speak MCP,
// and the whole point of a shared board is that it is shared.
//
//   node server.mjs board
//   node server.mjs agents
//   node server.mjs note <key> <value...>
//   node server.mjs send <to> <message...>
//   node server.mjs inbox <name>
//   node server.mjs claim <name> <path> <reason...>
//   node server.mjs release <name>
//
// A CLI caller is not a long-lived process, so it passes its name per command
// rather than registering once. Its claims carry no pid, which means they fall
// back to the TTL — a shell script cannot be probed for liveness the way a
// server process can.
/* ── dashboard ────────────────────────────────────────────────────────────── */

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
// keeps the no-dependencies rule this file has kept from the start.
function renderStatusHtml(state) {
  {
    pruneAgents(state);
    const now = Date.now();
    const ago = (iso) => {
      const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.round(s / 60)}m ago`;
      return `${Math.round(s / 3600)}h ago`;
    };
    // Anything the agents wrote is untrusted text going into HTML.
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

    const agentCards = agents.length
      ? agents
          .map(([name, a]) => {
            // Two minutes without a bus call and it is probably idle rather
            // than working. Said as "quiet", not "offline" — the bus cannot
            // tell the difference and should not pretend to.
            const quiet = now - Date.parse(a.lastSeen ?? 0) > 120_000;
            return `<div class="card${quiet ? " quiet" : ""}">
        <div class="row"><span class="dot"></span><b>${esc(name)}</b>
          <span class="seen">${esc(ago(a.lastSeen ?? new Date(0).toISOString()))}</span></div>
        <p class="lane">${esc(a.lane || "no lane stated")}</p>
        <p class="path">${esc(a.cwd || "")}</p>
      </div>`;
          })
          .join("")
      : "<p class=\"empty\">Nobody on the bus. An agent appears here after its first command.</p>";

    const boardRows = board.length
      ? board
          .map(
            ([k, v]) => `<details><summary><b>${esc(k)}</b>
        <span class="seen">${esc(v.by)} · ${esc(ago(v.at))}</span></summary>
        <p>${esc(v.value)}</p></details>`
          )
          .join("")
      : "<p class=\"empty\">The board is empty.</p>";

    return `<!doctype html>
<meta charset="utf-8"><title>agent-bus</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<style>
  :root { color-scheme: light dark; --bg:#f6f7f5; --fg:#16201a; --mut:#5d6b5f;
    --card:#fff; --line:#dfe4dc; --ok:#2f6b3f; --warn:#b4530a; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#11150f; --fg:#e4ebe2; --mut:#93a094; --card:#19200f1a; --line:#2a3329; } }
  body { margin:0; padding:28px; background:var(--bg); color:var(--fg);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  h1 { font-size:15px; margin:0 0 2px; letter-spacing:.02em; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em;
    color:var(--mut); margin:26px 0 8px; font-weight:600; }
  .sub { color:var(--mut); font-size:12px; margin:0 0 4px; }
  .grid { display:grid; gap:8px; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:11px 13px; }
  .card.quiet { opacity:.55; }
  .row { display:flex; align-items:center; gap:7px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:0 0 auto; }
  .quiet .dot { background:var(--mut); }
  .seen { margin-left:auto; color:var(--mut); font-size:11px; }
  .lane { margin:5px 0 0; }
  .path { margin:3px 0 0; color:var(--mut); font-size:11px;
    overflow-wrap:anywhere; font-family:ui-monospace,monospace; }
  .lock { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--ok);
    border-radius:10px; padding:11px 13px; }
  .lock.held { border-left-color:var(--warn); }
  .empty { color:var(--mut); }
  details { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:9px 13px; margin-bottom:6px; }
  summary { cursor:pointer; display:flex; gap:8px; align-items:center; }
  details p { margin:9px 0 2px; color:var(--mut); overflow-wrap:anywhere; }
</style>
<h1>agent-bus</h1>
<p class="sub">Refreshes every 5s · ${esc(new Date().toLocaleTimeString())}</p>

<h2>Connected (${agents.length})</h2>
<div class="grid">${agentCards}</div>

<h2>Working tree</h2>
<div class="lock${held ? " held" : ""}">${esc(describeLock(lock))}</div>

<h2>Board (${board.length})</h2>
${boardRows}
`;
  }
}

// THE PAGE, as a file rather than a server.
//
// Written next to the state on every change, so opening
// tools/agent-bus/status.html in a browser and leaving it there shows the bus
// live — the meta refresh re-reads the file, and the file is rewritten whenever
// any agent does anything. No command to run, no port, no terminal.
//
// This is the difference between "there is a dashboard" and "there is a page I
// can look at": a status view you have to remember to start is one you stop
// using.
function writeStatusPage(state) {
  try {
    const tmp = `${STATUS_PAGE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, renderStatusHtml(state));
    fs.renameSync(tmp, STATUS_PAGE);
  } catch {
    // Never let the page break the bus. A failed write here is cosmetic; the
    // tools that agents depend on must still return.
  }
}

function dashboardHtml() {
  return withState((state) => renderStatusHtml(state));
}

function runDashboard(port) {
  // Imported here, not at the top: every other path in this file is a stdio
  // server or a one-shot command that has no business opening a socket.
  return import("node:http").then(({ default: http }) => {
    const server = http.createServer((req, res) => {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
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
  });
}

function runCli(argv) {
  const [cmd, ...rest] = argv;
  const say = (t) => { process.stdout.write(String(t) + "\n"); };
  try {
    switch (cmd) {
      case "board":
        return say(callTool("board", {}));
      case "agents":
        return say(callTool("agents", {}));
      case "status":
        return say(callTool("status", {}));
      case "dashboard":
        // Long-running, unlike every other verb here, so it returns the
        // listener rather than falling through to the process exit below.
        return runDashboard(Number(rest[0]) || 7777);
      case "note": {
        const [key, ...v] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("note", { key, value: v.join(" ") }));
      }
      case "send": {
        const [to, ...v] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("send", { to, message: v.join(" ") }));
      }
      case "inbox": {
        myName = rest[0] || process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("inbox", {}));
      }
      case "claim": {
        const [name, target, ...v] = rest;
        myName = name;
        registerCli(myName);
        return say(callTool("claim_tree", { path: target, reason: v.join(" ") }));
      }
      case "release": {
        myName = rest[0];
        registerCli(myName);
        return say(callTool("release_tree", {}));
      }
      default:
        say("agent-bus — usage:");
        say("  dashboard [port] | status | board | agents | note <key> <value> | send <to> <msg>");
        say("  inbox <name> | claim <name> <path> <reason> | release <name>");
        say("");
        say("Set AGENT_BUS_NAME to avoid passing your name each time.");
        process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(String(err.message || err) + "\n");
    process.exitCode = 1;
  }
}

// A CLI invocation is a fresh process every time, so it re-announces itself
// rather than holding a registration.
function registerCli(name) {
  if (!name) throw new Error("A name is required.");
  withState((state) => {
    const prior = state.agents[name];
    state.agents[name] = {
      sessionKey: prior?.sessionKey ?? SESSION_KEY,
      lane: prior?.lane ?? "cli",
      cwd: process.cwd(),
      registeredAt: prior?.registeredAt ?? nowIso(),
      lastSeen: nowIso(),
    };
  });
}

if (process.argv.length > 2) {
  IS_CLI = true;
  runCli(process.argv.slice(2));
  // Every verb here is one-shot and exits — except `dashboard`, which is a
  // listener. Exiting on it would tear the socket down before the first
  // request, so it opts out and Node stays alive on its own handle.
  if (process.argv[2] !== "dashboard") {
    process.exit(process.exitCode ?? 0);
  }
}

/* ── JSON-RPC over stdio ──────────────────────────────────────────────────── */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  // Notifications have no id and must not be answered.
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      return write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-bus", version: VERSION },
        },
      });
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "tools/list") {
      return write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "tools/call") {
      const text = callTool(params?.name, params?.arguments ?? {});
      return write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(text) }] },
      });
    }
    if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
    if (isNotification) return;
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (err) {
    if (isNotification) return;
    // Tool failures come back as content with isError, not as protocol errors —
    // a refused lock is a normal outcome the agent should read and act on.
    if (method === "tools/call") {
      return write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(err.message || err) }], isError: true },
      });
    }
    write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err.message || err) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue; // Not our problem to fix; skip the malformed line.
    }
    handle(req);
  }
});

// Release the lock on the way out so a clean exit never leaves the tree claimed.
function releaseOnExit() {
  try {
    if (!myName) return;
    withState((state) => {
      if (state.lock && state.lock.holder === myName) state.lock = null;
    });
  } catch {
    /* best effort — the TTL covers us */
  }
}
process.on("exit", releaseOnExit);
process.on("SIGINT", () => { releaseOnExit(); process.exit(0); });
process.on("SIGTERM", () => { releaseOnExit(); process.exit(0); });
process.stdin.on("end", () => { releaseOnExit(); process.exit(0); });
