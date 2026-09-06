// agent-bus checks. Drives the real server over real stdio, two processes at
// once, because the failure being prevented is a RACE and a single-process test
// cannot see it.
//
// Run:  node e2e-agent-bus.mjs
//
// State is isolated per run via AGENT_BUS_HOME, so this never touches the repo's
// real bus.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.mjs");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-test-"));

let pass = 0, fail = 0;
const t = (n, c, d = "") => {
  c ? (pass++, console.log("  PASS " + n)) : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
};

// A session: one server process, spoken to over stdio the way a client does.
function session(label) {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: HOME,                       // not a git repo -> temp fallback, isolated
    env: { ...process.env, TEMP: HOME, TMPDIR: HOME },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      waiters.set(myId, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  return {
    label,
    rpc,
    async call(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      return { text: r.result?.content?.[0]?.text ?? "", isError: !!r.result?.isError };
    },
    kill: () => proc.kill(),
  };
}

const a = session("a");
const b = session("b");

console.log("[protocol]");
const init = await a.rpc("initialize", {});
t("initialize returns a protocol version", !!init.result?.protocolVersion, JSON.stringify(init.result));
t("...and identifies the server", init.result?.serverInfo?.name === "agent-bus");
await b.rpc("initialize", {});
const list = await a.rpc("tools/list", {});
t("tools/list returns the tool set", (list.result?.tools?.length ?? 0) === 8,
  `got ${list.result?.tools?.length}`);
t("every tool declares an input schema",
  list.result.tools.every((x) => x.inputSchema && x.inputSchema.type === "object"));
t("a notification draws no reply", await (async () => {
  // If the server answered a notification it would desync every later id.
  b.rpc("notifications/initialized", {});
  const r = await b.call("agents");
  return typeof r.text === "string";
})());

console.log("\n[identity]");
const early = await a.call("claim_tree", { path: "/x", reason: "too soon" });
t("acting before register is refused", early.isError && early.text.includes("register"));
t("register succeeds", (await a.call("register", { name: "lane-d", lane: "components UI" })).text.includes("lane-d"));
await b.call("register", { name: "opus-desktop", lane: "desktop pass" });
const roster = await a.call("agents");
t("each agent sees the other", roster.text.includes("opus-desktop"));
t("...and its lane", roster.text.includes("desktop pass"));
t("...and knows which one is itself", roster.text.includes("(you)"));
const dup = await b.call("register", { name: "lane-d" });
t("a live name cannot be taken twice", dup.isError && dup.text.includes("already registered"));

console.log("\n[the working-tree lock — the point of the exercise]");
const claimed = await a.call("claim_tree", { path: "C:/repo", reason: "rebase lane D", minutes: 5 });
t("first claim succeeds", !claimed.isError && claimed.text.includes("Claimed"));
const blocked = await b.call("claim_tree", { path: "C:/repo", reason: "switch branches" });
t("SECOND CLAIM IS REFUSED", blocked.isError, blocked.text);
t("...and names who holds it", blocked.text.includes("lane-d"));
t("...and says what they are doing", blocked.text.includes("rebase lane D"));
t("...and tells the loser not to run checkout", blocked.text.toLowerCase().includes("checkout"));
const steal = await b.call("release_tree");
t("a non-holder cannot release someone else's claim", steal.isError, steal.text);
t("the holder can re-claim its own lock (extending it)",
  !(await a.call("claim_tree", { path: "C:/repo", reason: "still going" })).isError);
t("release works for the holder", (await a.call("release_tree")).text.includes("Released"));
t("...and the tree is then free", (await b.call("agents")).text.includes("free"));
t("now the other agent can take it",
  !(await b.call("claim_tree", { path: "C:/repo", reason: "my turn" })).isError);
await b.call("release_tree");

console.log("\n[concurrency — two processes racing for the same claim]");
// Fire both claims without awaiting either, so they genuinely overlap.
const race = await Promise.all([
  a.call("claim_tree", { path: "C:/race", reason: "A" }),
  b.call("claim_tree", { path: "C:/race", reason: "B" }),
]);
const winners = race.filter((r) => !r.isError);
const losers = race.filter((r) => r.isError);
t("EXACTLY ONE agent wins the race", winners.length === 1,
  `winners=${winners.length} losers=${losers.length}`);
t("...and exactly one is refused", losers.length === 1);
t("...and the loser is told who won", losers[0].text.includes("HELD by"));
// Clean up whichever won.
await a.call("release_tree");
await b.call("release_tree");

console.log("\n[messages]");
t("send to an unregistered name is refused",
  (await a.call("send", { to: "nobody", message: "hi" })).isError);
await a.call("send", { to: "opus-desktop", message: "rebase before you commit" });
const inbox = await b.call("inbox");
t("the message arrives", inbox.text.includes("rebase before you commit"));
t("...tagged with the sender", inbox.text.includes("lane-d"));
t("reading marks it read", (await b.call("inbox")).text === "No new messages.");
t("...but it is still retrievable on request",
  (await b.call("inbox", { include_read: true })).text.includes("rebase before"));
await a.call("send", { to: "all", message: "heads up everyone" });
t("a broadcast reaches others", (await b.call("inbox")).text.includes("heads up"));
t("...and is not echoed back to its sender",
  !(await a.call("inbox")).text.includes("heads up"));

console.log("\n[the noticeboard — facts that outlive the conversation]");
await a.call("note", { key: "table-pattern", value: "DataTable now, not PlantCatalogueManager" });
const board1 = await b.call("board");
t("a note is visible to another agent", board1.text.includes("DataTable now"));
t("...attributed", board1.text.includes("lane-d"));
const upd = await b.call("note", { key: "table-pattern", value: "DataTable, see ChemicalProductsManager" });
t("a note can be corrected in place", upd.text.includes("was set by lane-d"));
t("...and the new value replaces the old",
  (await a.call("board")).text.includes("ChemicalProductsManager") &&
  !(await a.call("board")).text.includes("not PlantCatalogueManager"));
// The whole reason the board exists: b never saw a's message, only the note.
const c = session("c");
await c.rpc("initialize", {});
await c.call("register", { name: "late-arrival", lane: "joined after the fact" });
const lateBoard = await c.call("board");
t("AN AGENT THAT ARRIVED LATER STILL SEES THE FACT", lateBoard.text.includes("ChemicalProductsManager"));
t("...though it has no messages, having missed them",
  (await c.call("inbox")).text === "No new messages.");

console.log("\n[survives a crash]");
// Claim, then kill the process without releasing.
const d = session("d");
await d.rpc("initialize", {});
await d.call("register", { name: "crasher", lane: "about to die" });
await d.call("claim_tree", { path: "C:/crash", reason: "will not survive", minutes: 240 });
d.kill();
await new Promise((r) => setTimeout(r, 300));
const afterCrash = await a.call("claim_tree", { path: "C:/crash", reason: "picking up" });
t("a crashed holder's claim does not deadlock the others",
  !afterCrash.isError, afterCrash.text);
await a.call("release_tree");

console.log("\n[CLI mode — for shells and non-MCP agents]");
// GLM runs from PowerShell via ollama and can execute files, so it joins here
// rather than over MCP. A CLI process exits immediately, so its claims must NOT
// record a pid — otherwise the liveness check reads every one as abandoned and
// the next shell steals the tree.
const cli = (...a) => {
  const r = spawnSync(process.execPath, [SERVER, ...a],
    { cwd: HOME, env: { ...process.env, TEMP: HOME, TMPDIR: HOME }, encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
};
t("a shell can post to the board", cli("note", "from-shell", "hello from powershell").includes("Posted"));
t("...and an MCP agent sees it", (await a.call("board")).text.includes("hello from powershell"));
t("a shell can read the board", cli("board").includes("hello from powershell"));
t("a shell can claim the tree", cli("claim", "glm", "C:/cli", "building").includes("Claimed"));
t("A SECOND SHELL IS REFUSED — a CLI claim is not stealable",
  cli("claim", "other", "C:/cli", "switching").includes("REFUSED"));
t("...and is told who holds it", cli("claim", "other", "C:/cli", "switching").includes("glm"));
t("the shell can release its own claim", cli("release", "glm").includes("Released"));
t("...and then another can take it", cli("claim", "other", "C:/cli", "my turn").includes("Claimed"));
cli("release", "other");
t("an unknown CLI verb prints usage rather than crashing", cli("wat").includes("usage"));

console.log("\n[bad input never takes the server down]");
t("unknown tool errors without dying", (await a.call("no_such_tool")).isError);
t("missing args error without dying", (await a.call("note", { key: "x" })).isError);
t("the server is still answering afterwards", (await a.call("agents")).text.includes("Active agents"));

a.kill(); b.kill(); c.kill();
// Best effort: on Windows a just-killed child can still hold the directory.
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* leaves a temp dir; harmless */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
