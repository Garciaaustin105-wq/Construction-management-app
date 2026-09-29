// cloud/deploy/package.mjs — build the cloud (tsc), then write
// cloud/deploy/out/camplat-api.zip containing EXACTLY what
// cloud/lambda/router.mjs can load at runtime, including every lazily
// imported module (CLOUD-AWS-SPEC.md section C).
//
// The file list is never hand-maintained: this script statically walks the
// REAL import graph starting at cloud/lambda/router.mjs -- static
// `import ... from`, bare `import "x"`, dynamic `import("x")` and CJS
// `require("x")` -- resolving every relative specifier to a file on disk and
// recursing into it. A bare specifier is included only if it is a `node:`
// builtin or an `@aws-sdk/` package (both supplied by the Lambda runtime
// itself, never bundled -- CLOUD-AWS-SPEC.md section E's own decision); any
// other bare specifier is a hard error, not a silent skip (build rule 10:
// refuse rather than guess about what the runtime does or doesn't have).
// This also means the walker needs no edit when cloud/api/dynamoStore.mjs
// and cloud/api/dynamoKeys.mjs land -- it picks them up the moment
// router.mjs's own lazy `import("../api/dynamoStore.mjs")` resolves.
//
// Then the zip proves itself: extract to a temp dir, assert every entry
// uses forward slashes and none is a forbidden file (node_modules, .md,
// .pem, .key, harness/test files, raw .ts source), then import
// cloud/lambda/router.mjs and cloud/api/dynamoStore.mjs from THAT extracted
// copy -- with only the AWS SDK supplied from outside, via a directory
// junction to cloud/node_modules -- and run createRouter from the
// extracted router.mjs against the memory store from the SOURCE tree,
// checking an unknown route gives 404 and a bad login gives 401. No AWS
// resource is touched anywhere in this file.
//
// Run from camera-platform/ (or anywhere): node cloud/deploy/package.mjs

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // camera-platform/cloud/deploy
const CLOUD_DIR = path.resolve(HERE, "..");                // camera-platform/cloud
const ROOT_DIR = path.resolve(CLOUD_DIR, "..");             // camera-platform
const OUT_DIR = path.join(HERE, "out");
const ZIP_PATH = path.join(OUT_DIR, "camplat-api.zip");
const ENTRY_POINT = path.join(CLOUD_DIR, "lambda", "router.mjs");
const TAR_EXE = "C:\\Windows\\System32\\tar.exe";

const toPosix = (p) => p.split(path.sep).join("/");
const relPosix = (p) => toPosix(path.relative(ROOT_DIR, p));

function step(name, fn) {
  console.log(`\n== ${name} ==`);
  return fn();
}

function fail(message) {
  console.error(`\npackage.mjs FAILED: ${message}`);
  process.exit(1);
}

// ---- 1. build the cloud. Bare `npx tsc` here runs an unrelated cached
// stub package ("tsc" 2.0.4) that exits 0 and compiles nothing -- a green
// build that proves nothing (bus note camera-platform-tsc-command). ----
step("tsc -p cloud/tsconfig.json", () => {
  execSync("npx --yes --package typescript -- tsc -p tsconfig.json", {
    cwd: CLOUD_DIR,
    stdio: "inherit",
  });
});

// ---- 2. walk the real import graph from cloud/lambda/router.mjs ----

function stripBlockComments(src) {
  // JSDoc (`/** ... */`) is where every false-positive lives: type-only
  // references like `@property {import("./store.mjs").Store} store` (never
  // a real runtime import -- store.mjs is JSDoc typedefs only, per its own
  // header) and mentions of the UNCOMPILED "../contracts/scope.js" path.
  // Real dynamic imports and requires live in code, never in a block
  // comment, so stripping these first removes the false positives without
  // touching anything real.
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

const SPEC_PATTERNS = [
  /\bimport\s+[^'"()]*?\bfrom\s*["']([^"']+)["']/g, // import x from "y"; import {a} from "y"
  /\bexport\s+[^'"()]*?\bfrom\s*["']([^"']+)["']/g, // export {a} from "y"; export * from "y"
  /(?:^|[;\n{}])\s*import\s*["']([^"']+)["']/g, // bare side-effect import "y"
  /\bimport\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("y")
  /\brequire\(\s*["']([^"']+)["']\s*\)/g, // CJS require("y")
];

function extractSpecifiers(src, fileLabel) {
  const code = stripBlockComments(src);
  const specs = new Set();
  for (const re of SPEC_PATTERNS) {
    let m;
    while ((m = re.exec(code))) specs.add(m[1]);
  }
  // Defensive: a dynamic import() with a NON-literal specifier (a variable,
  // a template with an expression) would be invisible to the regex above --
  // fail loudly rather than silently ship an incomplete zip.
  const allDynamic = code.match(/\bimport\(\s*/g) ?? [];
  const literalDynamic = code.match(/\bimport\(\s*["'][^"']+["']\s*\)/g) ?? [];
  if (allDynamic.length !== literalDynamic.length) {
    throw new Error(`${fileLabel}: a dynamic import() with a non-literal specifier -- the static walker cannot trace it`);
  }
  return specs;
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, path.join(base, "index.mjs"), path.join(base, "index.js")];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(
    `cannot resolve "${spec}" imported from ${relPosix(fromFile)} -- looked for: ${candidates.map(relPosix).join(", ")}` +
      (spec.includes("dynamoStore") || spec.includes("dynamoKeys")
        ? " (has this file been written yet? CLOUD-AWS-SPEC.md section A owns it)"
        : ""),
  );
}

const ALLOWED_BARE_PREFIXES = ["node:", "@aws-sdk/"];
const RUNTIME_EXTERNALS = new Set();
/** absolute path -> posix path relative to ROOT_DIR, insertion order preserved. */
const included = new Map();

function walk(absPath) {
  if (included.has(absPath)) return;
  included.set(absPath, relPosix(absPath));
  const src = fs.readFileSync(absPath, "utf8");
  for (const spec of extractSpecifiers(src, relPosix(absPath))) {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      walk(resolveRelative(absPath, spec));
    } else if (ALLOWED_BARE_PREFIXES.some((p) => spec.startsWith(p))) {
      RUNTIME_EXTERNALS.add(spec);
    } else {
      throw new Error(
        `unexpected external dependency "${spec}" imported from ${relPosix(absPath)}: neither a node: builtin nor an ` +
          `@aws-sdk/ package -- CLOUD-AWS-SPEC.md section E says the Lambda runtime supplies only those. Either this ` +
          `needs vendoring (package.mjs does not support that) or it is a mistake.`,
      );
    }
  }
}

step("walk the import graph from cloud/lambda/router.mjs", () => {
  try {
    walk(ENTRY_POINT);
  } catch (err) {
    fail(err.message);
  }
  console.log(`  ${included.size} local file(s), ${RUNTIME_EXTERNALS.size} runtime-supplied external(s) not bundled:`);
  for (const f of included.values()) console.log(`    include  ${f}`);
  for (const e of RUNTIME_EXTERNALS) console.log(`    runtime  ${e} (not in the zip -- the Lambda runtime supplies it)`);
});

// Sanity net: even though every included file came from a real, followed
// import, refuse to ship anything that matches a forbidden pattern.
const FORBIDDEN = [
  [/\.md$/i, "markdown doc"],
  [/\.pem$/i, "PEM file"],
  [/\.key$/i, "key file"],
  [/(^|\/)node_modules(\/|$)/, "node_modules"],
  [/(^|\/)harness(\/|$)|\.harness\.mjs$/i, "harness/test file"],
  [/\.ts$/i, "raw TypeScript source (should be compiled cloud/dist/**/*.js)"],
  [/\.(mp4|mkv|avi|mov|jpg|jpeg|png|gif)$/i, "footage/media file"],
];
step("sanity check: nothing forbidden made it into the include set", () => {
  for (const rel of included.values()) {
    for (const [re, label] of FORBIDDEN) {
      if (re.test(rel)) fail(`the import graph pulled in a ${label}: ${rel}`);
    }
  }
});

// ---- 3. write the zip: forward-slash entries, rooted at ROOT_DIR so
// cloud/lambda/router.mjs lands at that exact path (Handler: cloud/lambda/
// router.handler). PowerShell's Compress-Archive writes backslash entries
// on Windows and breaks Lambda -- use bsdtar instead (CLOUD-AWS-SPEC.md
// section C). ----
step("write the zip", () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH);
  const entries = [...included.values()];
  execFileSync(TAR_EXE, ["-a", "-c", "-f", ZIP_PATH, "-C", ROOT_DIR, ...entries], { stdio: "inherit" });
  const size = fs.statSync(ZIP_PATH).size;
  console.log(`  wrote ${relPosix(ZIP_PATH)}: ${entries.length} entries, ${size} bytes`);
});

// A one-line README for the directory this script owns writing INTO --
// package.mjs does not own cloud/.gitignore, so it never edits it (it also
// already ignores deploy/out/, verified by hand this session).
step("out/README", () => {
  fs.writeFileSync(
    path.join(OUT_DIR, "README.txt"),
    "Build output only (camplat-api.zip) -- written by package.mjs, never hand-edited, never committed.\n",
  );
});

// ---- 4. prove the zip: extract, check entries, import from the extracted
// copy, run createRouter against the memory store from the SOURCE tree. ----
async function proveZip() {
  const listing = execFileSync(TAR_EXE, ["-tf", ZIP_PATH], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter((l) => l.length > 0);

  for (const entry of listing) {
    if (entry.includes("\\")) fail(`zip entry uses a backslash, Lambda will not load it: ${entry}`);
    for (const [re, label] of FORBIDDEN) {
      if (re.test(entry)) fail(`zip entry is a forbidden ${label}: ${entry}`);
    }
  }
  if (!listing.includes("cloud/lambda/router.mjs")) fail(`the zip has no cloud/lambda/router.mjs entry`);
  console.log(`  ${listing.length} entries, all forward-slash, none forbidden`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "camplat-zip-proof-"));
  try {
    execFileSync(TAR_EXE, ["-xf", ZIP_PATH, "-C", tmpRoot], { stdio: "inherit" });

    // Only the AWS SDK is supplied from outside the zip, via a junction to
    // cloud/node_modules -- never copied into the zip itself.
    const realNodeModules = path.join(CLOUD_DIR, "node_modules");
    if (fs.existsSync(realNodeModules)) {
      fs.mkdirSync(path.join(tmpRoot, "cloud"), { recursive: true });
      fs.symlinkSync(realNodeModules, path.join(tmpRoot, "cloud", "node_modules"), "junction");
    } else {
      console.log(`  note: ${relPosix(realNodeModules)} does not exist locally -- skipping the node_modules junction`);
    }

    const extractedRouter = path.join(tmpRoot, "cloud", "lambda", "router.mjs");
    if (!fs.existsSync(extractedRouter)) fail(`extracted zip is missing cloud/lambda/router.mjs`);
    const { createRouter } = await import(pathToFileURL(extractedRouter).href);

    const extractedDynamoStore = path.join(tmpRoot, "cloud", "api", "dynamoStore.mjs");
    if (!fs.existsSync(extractedDynamoStore)) fail(`extracted zip is missing cloud/api/dynamoStore.mjs`);
    await import(pathToFileURL(extractedDynamoStore).href); // proves the module loads; no AWS call is made

    const { createMemoryStore } = await import(pathToFileURL(path.join(CLOUD_DIR, "api", "memoryStore.mjs")).href);
    const { randomBytes } = await import("node:crypto");

    const route = createRouter({
      store: createMemoryStore(),
      nowMs: () => Date.now(),
      randomBytes,
      log: () => {},
      scryptParams: { N: 1024, r: 8, p: 1 }, // cheap params -- this is a proof run, not production
    });

    const apiEvent = (method, rawPath, { body, headers = {} } = {}) => ({
      version: "2.0",
      routeKey: `${method} ${rawPath}`,
      rawPath,
      rawQueryString: "",
      headers,
      requestContext: { http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "127.0.0.1" } },
      isBase64Encoded: false,
      ...(body !== undefined ? { body } : {}),
    });

    const notFound = await route(apiEvent("GET", "/nope"));
    if (notFound.statusCode !== 404) fail(`expected 404 for an unknown route from the EXTRACTED router, got ${notFound.statusCode}: ${notFound.body}`);

    const badLogin = await route(
      apiEvent("POST", "/login", {
        body: JSON.stringify({ login: "nobody@example.com", password: "wrong password here" }),
        headers: { "content-type": "application/json" },
      }),
    );
    if (badLogin.statusCode !== 401) fail(`expected 401 for a bad login from the EXTRACTED router, got ${badLogin.statusCode}: ${badLogin.body}`);

    console.log("  OK: the extracted zip's router.mjs and dynamoStore.mjs both load; unknown route -> 404; bad login -> 401");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

await step("prove the zip (extract + import + route)", proveZip);

console.log("\npackage.mjs: OK");
