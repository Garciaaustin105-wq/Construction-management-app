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
//
// THE HUB LIVES IN hub.mjs, BESIDE THIS FILE — the dashboard page, its HTTP
// server, the workers started from the window, and the status.html snapshot.
// It is SPAWNED (`server.mjs dashboard` runs it as a child process), never
// imported, so a render bug in the hub can never take down the MCP tool list —
// the same reasoning as context-cost.cjs. This file exports the surface the hub
// needs and knows nothing else about it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

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
      state = { agents: {}, lock: null, messages: [], board: {}, tasks: [], taskSeq: 0 };
    }
    state.agents ||= {};
    state.messages ||= [];
    state.board ||= {};
    state.tasks ||= [];

    const result = fn(state);

    // Write-then-rename, so a reader never sees a half-written file.
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE);
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

/**
 * Lend this process's identity to a caller for the length of `fn`.
 *
 * The hub's window (hub.mjs) and the CLI both act on behalf of a name without
 * being a registered session — the web UI borrows "desk", a shell passes its
 * name per command. myName and IS_CLI are module state on purpose: callTool()
 * reads them for attribution and for whether a tree claim should carry a pid.
 * Exported so the hub can borrow WITHOUT reaching into this module's internals.
 */
function asActor(actor, fn) {
  const prevName = myName;
  const prevCli = IS_CLI;
  myName = actor;
  IS_CLI = true;
  try {
    return fn();
  } finally {
    myName = prevName;
    IS_CLI = prevCli;
  }
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

    case "task_add":
      return withState((state) => {
        touch(state);
        state.tasks ||= [];
        const id = nextTaskId(state);
        state.tasks.push({
          id,
          lane: args.lane || "local",
          title: args.title,
          prompt: args.prompt,
          status: "queued",
          runner_id: args.runner_id || null,
          by: myName || "cli",
          at: nowIso(),
        });
        return `Queued ${id} on lane "${args.lane || "local"}": ${args.title}`;
      });

    case "runners":
      return readRunners()
        .map((r) => `${r.enabled ? "  " : "x "}${r.id} — ${r.label ?? r.type}` + (r.note ? `\n     ${r.note}` : ""))
        .join("\n");

    case "tasks":
      return withState((state) => {
        touch(state);
        const rows = (state.tasks ?? []).slice(-20).reverse();
        if (!rows.length) return "No tasks queued.";
        return rows
          .map((t) => {
            const head = `${t.id} [${t.status}] ${t.lane} — ${t.title}`;
            return t.result ? `${head}\n  ${t.result.slice(0, 400)}` : head;
          })
          .join("\n");
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
/* ── the task queue ───────────────────────────────────────────────────────── */

// The board holds facts. This holds WORK — and something actually runs it.
//
// A queue nobody executes is a to-do list, which is what the board already was.
// `work` is the missing half: a loop that takes the next queued task for its
// lane, runs it, and writes the answer back where everyone can see it.
//
// LOCAL OUTPUT IS A DRAFT, NEVER A COMMIT. The runner posts text to the queue.
// It does not touch the repo, run git, or write a file into src/. That is not a
// limitation to be lifted later — an unreviewed model writing to a codebase is
// how you get plausible wrong code merged at 3am, and this project has already
// had one local-model draft with four defects in it.

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.AGENT_BUS_MODEL || "gpt-oss:20b";

function nextTaskId(state) {
  state.taskSeq = (state.taskSeq ?? 0) + 1;
  return `t${state.taskSeq}`;
}

/**
 * The runners the bus may invoke, from runners.json beside this file.
 *
 * Read fresh each time rather than cached: adding a model or filling in the GLM
 * command should take effect on the next task, not on the next restart of a
 * worker that has been up for hours.
 */
function readRunners() {
  try {
    const raw = fs.readFileSync(new URL("./runners.json", import.meta.url), "utf8");
    const list = JSON.parse(raw).runners ?? [];
    return list.filter((r) => r && r.id && r.type);
  } catch {
    // No config, or broken JSON. Fall back to the one model this project is
    // known to use, so a typo in the file cannot take the whole lane down.
    return [{ id: "gpt-oss", label: "gpt-oss:20b — local", type: "ollama", model: "gpt-oss:20b", enabled: true }];
  }
}

function findRunner(id) {
  const runners = readRunners();
  const found = runners.find((r) => r.id === id) ?? runners.find((r) => r.enabled);
  if (!found) throw new Error("No enabled runner in runners.json.");
  if (!found.enabled) {
    throw new Error(
      `Runner "${found.id}" is disabled in runners.json. ${found.note ?? ""}`.trim()
    );
  }
  return found;
}

/** Ask an ollama model over HTTP. */
async function askOllama(runner, prompt) {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: runner.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          // A THINKING model spends output tokens reasoning BEFORE it answers,
          // so a budget sized for the answer alone returns an empty response
          // with the reasoning stranded in `thinking`. Found the hard way:
          // GLM at 80 tokens produced nothing at all.
          num_predict: runner.thinking ? 4000 : 1200,
        },
      }),
    });
  } catch {
    throw new Error(`Cannot reach ollama at ${OLLAMA}. Is it running? (ollama serve)`);
  }
  if (!res.ok) throw new Error(`ollama returned ${res.status}. Is "${runner.model}" pulled?`);
  const body = await res.json();
  const text = String(body.response ?? "").trim();
  if (text) return text;
  // Ran out of budget mid-thought. Say so, and hand back the reasoning rather
  // than an empty result — a partial answer is worth more than "returned
  // nothing", and it tells you exactly why.
  const thinking = String(body.thinking ?? "").trim();
  if (thinking) {
    return `[no final answer — the model was still reasoning when it ran out of output budget. Its thinking so far:]

${thinking}`;
  }
  throw new Error("The model returned nothing.");
}

/**
 * Run a command-line agent, prompt on stdin.
 *
 * spawn with an ARGUMENT LIST, never a joined string and never a shell. Nothing
 * in a prompt can then be read as an extra argument or a second command — and
 * prompts here are written by other agents, so that is not hypothetical.
 */
function askShell(runner, prompt) {
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise((resolve, reject) => {
        const child = spawn(runner.command, runner.args ?? [], {
          cwd: path.resolve(DIR, "..", ".."),
          shell: false,
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => {
          out += c;
        });
        child.stderr.on("data", (c) => {
          err += c;
        });
        child.on("error", (e) =>
          reject(new Error(`Could not start "${runner.command}": ${e.message}`))
        );
        // A CLI agent that hangs waiting for input would hold the lane forever.
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Runner timed out after 10 minutes."));
        }, 10 * 60 * 1000);
        child.on("close", (code) => {
          clearTimeout(timer);
          const text = out.trim();
          if (code !== 0 && !text) {
            reject(new Error(`Exited ${code}. ${err.trim().slice(0, 400)}`));
            return;
          }
          if (!text) {
            reject(new Error("The runner produced no output."));
            return;
          }
          resolve(text);
        });
        child.stdin.write(prompt);
        child.stdin.end();
      })
  );
}

function askRunner(runner, prompt) {
  return runner.type === "shell" ? askShell(runner, prompt) : askOllama(runner, prompt);
}

/**
 * Take the next queued task for a lane and mark it running, atomically.
 *
 * Claiming inside withState is what stops two runners taking the same task —
 * the same reason the working-tree lock exists. Returns null when the queue is
 * empty, which is the normal case and not an error.
 */
function claimNextTask(lane) {
  return withState((state) => {
    state.tasks ||= [];
    const task = state.tasks.find((t) => t.lane === lane && t.status === "queued");
    if (!task) return null;
    task.status = "running";
    task.startedAt = nowIso();
    task.runner = myName || "worker";
    return { ...task };
  });
}

function finishTask(id, patch) {
  return withState((state) => {
    state.tasks ||= [];
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, patch, { doneAt: nowIso() });
    return { ...task };
  });
}

/**
 * The runner. Polls for work in its lane, runs it, writes the answer back.
 *
 * Poll rather than push because the queue is a JSON file on disk — there is no
 * socket to subscribe to, and a five second poll on a local file costs nothing.
 */
async function runWorker(lane, runnerId) {
  const runner = findRunner(runnerId);
  process.stdout.write(`agent-bus worker: lane "${lane}", runner "${runner.id}" (${runner.label ?? runner.type})\n`);
  process.stdout.write(`ollama at ${OLLAMA}. Ctrl+C to stop.\n`);
  let idleLogged = false;
  for (;;) {
    const task = claimNextTask(lane);
    if (!task) {
      if (!idleLogged) {
        process.stdout.write("waiting for work...\n");
        idleLogged = true;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    idleLogged = false;
    process.stdout.write(`\n[${task.id}] ${task.title}\n  running...\n`);
    try {
      // A task may name its own runner; the worker's is the fallback.
      const chosen = task.runner_id ? findRunner(task.runner_id) : runner;
      const answer = await askRunner(chosen, task.prompt);
      finishTask(task.id, { status: "done", result: answer, model: chosen.id });
      process.stdout.write(`  done (${answer.length} chars)\n`);
    } catch (err) {
      // A failure is a RESULT, not a crash. It goes on the queue so the person
      // reading the hub sees why, instead of finding a task stuck on "running"
      // forever with no explanation.
      finishTask(task.id, { status: "failed", result: err.message, model: task.runner_id ?? runner.id });
      process.stdout.write(`  failed: ${err.message}\n`);
    }
  }
}

function runCli(argv) {
  const [cmd, ...rest] = argv;
  const rest0 = rest;
  const say = (t) => { process.stdout.write(String(t) + "\n"); };
  try {
    switch (cmd) {
      // Spawned rather than imported, so a broken analyser can never stop the
      // bus itself from starting. Synchronous on purpose: the CLI calls
      // process.exit() the moment runCli returns, so anything async here would
      // be torn down before it produced a line.
      case "cost":
        execFileSync(
          process.execPath,
          // .cjs, not .mjs, so DeepSource can parse it. Reason on the file.
          [path.join(import.meta.dirname, "context-cost.cjs"), ...rest0],
          { stdio: "inherit" }
        );
        return;
      case "board":
        return say(callTool("board", {}));
      case "agents":
        return say(callTool("agents", {}));
      case "status":
        return say(callTool("status", {}));
      case "tasks":
        return say(callTool("tasks", {}));
      case "runners":
        return say(callTool("runners", {}));
      case "task": {
        const [lane, title, ...rest] = rest0;
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("task_add", { lane, title, prompt: rest.join(" ") }));
      }
      case "work": {
        // Long-running, like dashboard.
        myName = process.env.AGENT_BUS_NAME || "worker";
        registerCli(myName);
        return runWorker(rest0[0] || "local", rest0[1] || DEFAULT_MODEL);
      }
      case "dashboard":
        // The hub lives in hub.mjs and runs as a CHILD PROCESS, not here —
        // a render bug in the hub must never take down the bus (see the header).
        // Long-running, like the child: this process waits on it, and the exit
        // skip at the bottom keeps Node alive on the child's handle.
        {
          const child = spawn(
            process.execPath,
            [path.join(import.meta.dirname, "hub.mjs"), ...rest0],
            { stdio: "inherit" }
          );
          child.on("exit", (code) => { process.exitCode = code ?? 0; });
          return;
        }
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
        say("  dashboard [port] | work [lane] [runner] | task <lane> <title> <prompt>");
        say("  tasks | runners | status | board | agents | note <key> <value> | send <to> <msg>");
        say("  cost [--full]   where the tokens actually went");
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

// The bus's public surface — what hub.mjs imports. The hub is a separate
// process (spawned by the dashboard verb, never imported here); these are the
// pieces it needs to render state, run actions and start workers.
export {
  DIR,
  asActor,
  askRunner,
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
};

// True only when THIS file is the entrypoint. hub.mjs imports this module for
// the surface above, and an import must neither start a CLI nor a stdio server.
const IS_MAIN = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (IS_MAIN && process.argv.length > 2) {
  IS_CLI = true;
  runCli(process.argv.slice(2));
  // Every verb here is one-shot and exits — except `dashboard`, which waits on
  // its child process, and `work`, which loops. Exiting on either would tear
  // it down before the first result, so they opt out and Node stays alive.
  if (process.argv[2] !== "dashboard" && process.argv[2] !== "work") {
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

// The stdio loop and the exit handlers below run only when this file IS the
// entrypoint (an MCP session spawns it with no arguments). An import — hub.mjs
// is the only one — must not touch stdin or install process handlers here.
if (IS_MAIN && process.argv.length <= 2) {
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
  const releaseOnExit = () => {
    try {
      if (!myName) return;
      withState((state) => {
        if (state.lock && state.lock.holder === myName) state.lock = null;
      });
    } catch {
      /* best effort — the TTL covers us */
    }
  };
  process.on("exit", releaseOnExit);
  process.on("SIGINT", () => { releaseOnExit(); process.exit(0); });
  process.on("SIGTERM", () => { releaseOnExit(); process.exit(0); });
  process.stdin.on("end", () => { releaseOnExit(); process.exit(0); });
}
