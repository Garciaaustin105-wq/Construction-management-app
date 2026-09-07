/**
 * Where the tokens actually went.
 *
 * Reads the Claude Code session transcripts for this repo and reports what was
 * paid for. It exists because we twice "fixed" token usage by guessing — first
 * by trimming MCP connectors, then by blaming repeated source-file reads — and
 * both guesses were wrong by an order of magnitude. The numbers were sitting in
 * the transcripts the whole time.
 *
 * The one fact that reframes everything: a cache read is the model re-reading
 * the conversation so far, and it happens on EVERY turn. So the cost of putting
 * something into context is not its size. It is its size multiplied by every
 * turn that comes after it.
 *
 *   node tools/agent-bus/context-cost.mjs          summary for this repo
 *   node tools/agent-bus/context-cost.mjs --full   plus per-tool attribution
 *
 * No dependencies, by the same rule as the rest of the bus.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Claude Code stores transcripts under a directory named after the working
// directory with every non-alphanumeric character replaced by a dash.
const REPO = path.resolve(import.meta.dirname, "..", "..");
const SESSION_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  REPO.replace(/[^a-zA-Z0-9]/g, "-")
);

const IMAGE = /\.(png|jpe?g|gif|webp|svg|pdf|bmp|tiff?)$/i;
const TOK = (chars) => Math.round(chars / 4); // close enough to rank by
const M = (n) => (n / 1e6).toFixed(2) + "M";
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "0.0") + "%";

function readSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.slice(0, 8), file: path.join(SESSION_DIR, f) }));
}

/** One pass over a transcript. Everything reported below is derived from this. */
function scan(file) {
  const s = {
    turns: 0,
    read: 0,
    write: 0,
    input: 0,
    output: 0,
    byTool: {}, // tool -> tokens of the RESULT it produced
    images: { tok: 0, n: 0 },
    texts: { tok: 0, n: 0 },
    files: {}, // basename -> tokens, for the offenders list
  };
  const nameOf = {}; // tool_use_id -> tool name
  const pathOf = {}; // tool_use_id -> file path, Read only

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return s;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue; // a half-written line at the tail is normal, not an error
    }

    const usage = x?.message?.usage;
    if (x.type === "assistant" && usage) {
      s.turns++;
      s.read += usage.cache_read_input_tokens || 0;
      s.write += usage.cache_creation_input_tokens || 0;
      s.input += usage.input_tokens || 0;
      s.output += usage.output_tokens || 0;
    }

    const content = x?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (b.type === "tool_use") {
        nameOf[b.id] = b.name;
        if (b.name === "Read") pathOf[b.id] = b.input?.file_path || "";
      } else if (b.type === "tool_result") {
        const text =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
        const tok = TOK(text.length);
        const name = nameOf[b.tool_use_id] || "(unknown)";
        s.byTool[name] = (s.byTool[name] || 0) + tok;

        // Attribute Read results to image vs text. The whole finding lives here.
        const p = pathOf[b.tool_use_id];
        if (p !== undefined) {
          const bucket = IMAGE.test(p) ? s.images : s.texts;
          bucket.tok += tok;
          bucket.n++;
          const base = p.split(/[\\/]/).pop() || "?";
          s.files[base] = (s.files[base] || 0) + tok;
        }
      }
    }
  }
  return s;
}

function main() {
  const full = process.argv.includes("--full");
  const sessions = readSessions();
  if (!sessions.length) {
    console.log("No session transcripts found at:\n  " + SESSION_DIR);
    process.exitCode = 1;
    return;
  }

  const scans = sessions.map((x) => ({ ...x, s: scan(x.file) })).filter((x) => x.s.turns);
  const T = scans.reduce(
    (a, x) => {
      a.read += x.s.read;
      a.write += x.s.write;
      a.input += x.s.input;
      a.output += x.s.output;
      a.turns += x.s.turns;
      return a;
    },
    { read: 0, write: 0, input: 0, output: 0, turns: 0 }
  );
  const all = T.read + T.write + T.input + T.output || 1;

  console.log("\nCONTEXT COST — " + path.basename(REPO));
  console.log("=".repeat(66));
  console.log(scans.length + " sessions, " + T.turns.toLocaleString() + " turns\n");
  console.log("  cache READ  (re-reading the conversation) " + M(T.read).padStart(9) + "  " + pct(T.read, all).padStart(6));
  console.log("  cache WRITE (new context added)           " + M(T.write).padStart(9) + "  " + pct(T.write, all).padStart(6));
  console.log("  input       (uncached)                    " + M(T.input).padStart(9) + "  " + pct(T.input, all).padStart(6));
  console.log("  output      (what was actually written)   " + M(T.output).padStart(9) + "  " + pct(T.output, all).padStart(6));

  console.log("\nCOST PER SESSION — context is re-read on every turn");
  console.log("-".repeat(66));
  console.log("  session    turns    avg ctx/turn         total re-read");
  for (const x of scans.sort((a, b) => b.s.read - a.s.read).slice(0, 10)) {
    const avg = Math.round(x.s.read / x.s.turns);
    console.log(
      "  " + x.id,
      String(x.s.turns).padStart(7),
      avg.toLocaleString().padStart(14),
      M(x.s.read).padStart(21)
    );
  }

  // The headline. Images are few in number and enormous in cost.
  const img = scans.reduce((a, x) => a + x.s.images.tok, 0);
  const imgN = scans.reduce((a, x) => a + x.s.images.n, 0);
  const txt = scans.reduce((a, x) => a + x.s.texts.tok, 0);
  const txtN = scans.reduce((a, x) => a + x.s.texts.n, 0);
  if (imgN || txtN) {
    console.log("\nWHAT WAS READ INTO CONTEXT");
    console.log("-".repeat(66));
    console.log("  images/PDF  " + String(imgN).padStart(5) + " reads " + String(img).padStart(10) + " tok   avg " + (imgN ? Math.round(img / imgN) : 0));
    console.log("  text files  " + String(txtN).padStart(5) + " reads " + String(txt).padStart(10) + " tok   avg " + (txtN ? Math.round(txt / txtN) : 0));
    if (imgN && txtN && txt) {
      console.log("\n  One image costs about " + Math.round(img / imgN / (txt / txtN)) + " source-file reads.");
    }
  }

  const files = {};
  for (const x of scans) {
    for (const [k, v] of Object.entries(x.s.files)) files[k] = (files[k] || 0) + v;
  }
  const worst = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (worst.length) {
    console.log("\nMOST EXPENSIVE FILES EVER READ");
    console.log("-".repeat(66));
    for (const [k, v] of worst) {
      console.log("  " + k.slice(0, 44).padEnd(45) + String(v).padStart(9) + " tok");
    }
  }

  if (full) {
    const byTool = {};
    for (const x of scans) {
      for (const [k, v] of Object.entries(x.s.byTool)) byTool[k] = (byTool[k] || 0) + v;
    }
    const tot = Object.values(byTool).reduce((a, b) => a + b, 0) || 1;
    console.log("\nTOOL RESULTS BY TOOL");
    console.log("-".repeat(66));
    for (const [k, v] of Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log("  " + k.slice(0, 40).padEnd(41) + String(v).padStart(9) + "  " + pct(v, tot).padStart(6));
    }
  }

  console.log("\n" + "=".repeat(66));
  console.log("What to do about it: docs/how-we-work.md → 'The context budget'\n");
}

main();
