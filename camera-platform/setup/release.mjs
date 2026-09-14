#!/usr/bin/env node
// Build the release tarball that setup/install.sh unpacks into /opt/camplat.
//
//   node setup/release.mjs [--allow-dirty]
//
// Run from camera-platform on the dev machine after tsc. It ships agent/, dist/,
// setup/, harness/ and a VERSION file naming the commit, with LF line endings:
// a Windows checkout is CRLF, and a CRLF bash script does not run on Linux.
// It refuses a stale dist/ (the box would run code that is not the source) and
// an uncommitted tree (VERSION would name a commit the code is not), unless
// --allow-dirty, which marks VERSION "-dirty".

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SHIPPED_DIRS = ["agent", "dist", "setup", "harness"];
export const TEXT_EXTENSIONS = [".mjs", ".js", ".ts", ".sh", ".json", ".md", ".html", ".css", ".txt"];

/**
 * The commit HEAD points at, and whether anything under `root` differs from it.
 * @returns {{ commit: string, dirty: boolean }}
 */
export function gitState(root) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: root, encoding: "utf8" }).trim() !== "";
  return { commit, dirty };
}

/**
 * Whether dist/ was compiled from the contracts/ that are on disk now.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function distFreshness(root) {
  const dist = path.join(root, "dist");
  let jsFiles;
  try {
    jsFiles = readdirSync(dist, { recursive: true }).filter(f => f.endsWith(".js"));
  } catch {
    return { ok: false, reason: "dist/ is missing: run tsc -p tsconfig.json first" };
  }
  if (jsFiles.length === 0) {
    return { ok: false, reason: "dist/ is missing: run tsc -p tsconfig.json first" };
  }
  let oldestJs = Infinity;
  for (const file of jsFiles) {
    const mtime = statSync(path.join(dist, file)).mtimeMs;
    if (mtime < oldestJs) oldestJs = mtime;
  }
  const contractsDir = path.join(root, "contracts");
  const tsFiles = readdirSync(contractsDir, { recursive: true }).filter(f => f.endsWith(".ts"));
  for (const rel of tsFiles) {
    const mtime = statSync(path.join(contractsDir, rel)).mtimeMs;
    if (mtime > oldestJs) {
      const relPath = rel.split(path.sep).join("/");
      return { ok: false, reason: `dist/ is stale: contracts/${relPath} changed after the last tsc; run tsc -p tsconfig.json first` };
    }
  }
  return { ok: true };
}

/**
 * Copy every file under SHIPPED_DIRS into stageDir, same relative paths,
 * converting CRLF to LF in files whose extension is in TEXT_EXTENSIONS.
 * @returns {number} how many files were copied
 */
export function stageFiles(root, stageDir) {
  let count = 0;
  for (const d of SHIPPED_DIRS) {
    for (const rel of readdirSync(path.join(root, d), { recursive: true })) {
      const src = path.join(root, d, rel);
      if (statSync(src).isDirectory()) continue;
      const dest = path.join(stageDir, d, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      if (TEXT_EXTENSIONS.includes(path.extname(rel))) {
        writeFileSync(dest, readFileSync(src, "utf8").replace(/\r\n/g, "\n"));
      } else {
        writeFileSync(dest, readFileSync(src));
      }
      count++;
    }
  }
  return count;
}

/**
 * @returns {number} the process exit code
 */
export function main(argv, root = process.cwd()) {
  const allowDirty = argv.includes("--allow-dirty");
  const fresh = distFreshness(root);
  if (!fresh.ok) {
    console.error(fresh.reason);
    return 1;
  }
  const { commit, dirty } = gitState(root);
  if (dirty && !allowDirty) {
    console.error("the tree has uncommitted changes: commit them, or pass --allow-dirty to build a -dirty release");
    return 1;
  }
  const version = commit + (dirty ? "-dirty" : "");
  const name = `camplat-${commit.slice(0, 12)}${dirty ? "-dirty" : ""}`;
  const stageRel = `release/stage-${name}`;
  const stageDir = path.join(root, "release", `stage-${name}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  try {
    const count = stageFiles(root, stageDir);
    writeFileSync(path.join(stageDir, "VERSION"), version + "\n");
    const tarRel = `release/${name}.tar.gz`;
    execFileSync("tar", ["-czf", tarRel, "-C", stageRel, "."], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    console.log(`${tarRel}  (${count} files, VERSION ${version})`);
    return 0;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("release.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
