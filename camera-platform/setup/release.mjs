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
//
// It also writes MANIFEST.json: every shipped file with its sha256, plus the
// commit and the build time. Nothing here signs it -- signing needs the key,
// which lives wherever the person holding it decided, and this runs on a build
// machine. `setup/sign-release.mjs` does that separately, and an appliance
// refuses a release whose manifest carries no signature it trusts.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// detector/: the AI worker (Python), run by agent/detect-service.mjs.
export const SHIPPED_DIRS = ["agent", "dist", "setup", "harness", "detector"];
export const TEXT_EXTENSIONS = [".mjs", ".js", ".ts", ".sh", ".json", ".md", ".html", ".css", ".txt", ".py"];

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
      // Bytecode a local test run left behind is built for the machine that
      // ran it, not the box. Python rebuilds its own from the shipped source.
      if (rel.split(/[\\/]/).includes("__pycache__") || rel.endsWith(".pyc")) continue;
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

/** Files a manifest never lists: it cannot contain its own hash, or its signature. */
export const MANIFEST_NAME = "MANIFEST.json";
export const SIGNATURE_NAME = "MANIFEST.sig";

/**
 * Every file under `stageDir`, hashed, as the manifest promises them.
 * Paths are relative with forward slashes, so the same release verifies the
 * same way whichever machine built it.
 * @returns {{ path: string, sha256: string, bytes: number }[]}
 */
export function hashTree(stageDir) {
  const files = [];
  for (const rel of readdirSync(stageDir, { recursive: true })) {
    const abs = path.join(stageDir, rel);
    if (statSync(abs).isDirectory()) continue;
    const relPath = String(rel).split(path.sep).join("/");
    if (relPath === MANIFEST_NAME || relPath === SIGNATURE_NAME) continue;
    const bytes = readFileSync(abs);
    files.push({
      path: relPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  // Sorted, so two builds of the same tree produce byte-identical manifests and
  // a diff between releases is readable.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * Write MANIFEST.json into the staged tree. Pretty-printed and newline
 * terminated: it is signed as bytes, so what it looks like is what is signed,
 * and a human should be able to read what they are signing.
 * @returns {number} how many files it lists
 */
export function writeManifest(stageDir, version, builtAtUtc) {
  const files = hashTree(stageDir);
  const manifest = { version, builtAtUtc, files };
  writeFileSync(path.join(stageDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
  return files.length;
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
    const builtAtUtc = new Date().toISOString();
    const listed = writeManifest(stageDir, version, builtAtUtc);
    const tarRel = `release/${name}.tar.gz`;
    execFileSync("tar", ["-czf", tarRel, "-C", stageRel, "."], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    console.log(`${tarRel}  (${count} files, VERSION ${version})`);
    console.log(`${MANIFEST_NAME} lists ${listed} files, built ${builtAtUtc} -- UNSIGNED.`);
    console.log(`Sign it with:  node setup/sign-release.mjs ${tarRel}`);
    return 0;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("release.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
