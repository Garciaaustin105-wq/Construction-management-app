/**
 * agent/device-identity.mjs (B1 phase-1 brief, piece 1) and the two camctl
 * commands built on top of it (piece 4: `camctl identity`, `camctl checkin
 * --dry-run`).
 *
 * THE FEARED FAILURES (build rule 19), in order:
 * - the device's own private key reaching anywhere but the file it lives
 *   in: a return value, a thrown error's message, console output, or a
 *   camctl process's stdout/stderr -- even when the box holds a fuzzed
 *   config full of OTHER secrets too (camera passwords, typed rtsp URLs);
 * - a corrupt or hand-tampered identity file being silently replaced
 *   instead of refused, which would orphan the box from any cloud record
 *   of its old deviceId;
 * - two callers racing to create the FIRST identity for a fresh stateDir
 *   and ending up with two different ones -- tested both within one
 *   process and, via a worker thread standing in for a second process (see
 *   _deviceIdentityWorker.mjs), across two.
 *
 * Mutation-checked by hand (build rule 20's spirit): temporarily removing
 * the deviceId/public-key cross-check in parseIdentityFile(), and
 * separately temporarily replacing writeIdentityFileAtomic()'s link() with
 * a plain rename(), each made the corresponding check below fail before the
 * fix was reverted.
 */
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createHash, verify as verifyBytes, randomBytes } from "node:crypto";
import { check, eq, same, report } from "./_assert.mjs";

// CAMPLAT_DEVICE_IDENTITY_UNDER_TEST: a mutated copy to run these checks
// against, so a hand mutation-check never edits the shared file.
const here = dirname(fileURLToPath(import.meta.url));
const modulePath = process.env.CAMPLAT_DEVICE_IDENTITY_UNDER_TEST ?? join(here, "../agent/device-identity.mjs");
const { loadOrCreateIdentity, signWithIdentity, DEVICE_IDENTITY_FILE, DEVICE_IDENTITY_VERSION, identityOwner } = await import(pathToFileURL(modulePath).href);
const camctlPath = process.env.CAMPLAT_CAMCTL_UNDER_TEST ?? join(here, "../agent/camctl.mjs");

console.log("deviceIdentity");

const root = await mkdtemp(join(tmpdir(), "camplat-device-identity-"));
let dirCounter = 0;
async function freshStateDir() {
  const dir = join(root, `state-${dirCounter++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// --state-dir is always passed explicitly below and wins over
// CAMPLAT_STATE_DIR in camctl.mjs's own flag resolution (`flag("state-dir")
// ?? process.env.CAMPLAT_STATE_DIR ?? ...`), so nothing here needs to touch
// the inherited environment at all.
function runCamctl(command, stateDir, extraArgs = []) {
  return spawnSync(process.execPath, [camctlPath, command, "--state-dir", stateDir, ...extraArgs], {
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/* ── created once, reused after ────────────────────────────────────────── */

await check("loadOrCreateIdentity creates on first use, and returns the SAME identity on every later call", async () => {
  const dir = await freshStateDir();
  const first = await loadOrCreateIdentity(dir);
  eq(first.created, true, "first call created it");
  eq(typeof first.deviceId, "string", "deviceId is a string");
  eq(first.deviceId.length > 0, true, "deviceId is non-empty");
  eq(/^[A-Z2-7]{26}$/.test(first.deviceId), true, "deviceId is 26 unpadded base32 characters");

  const second = await loadOrCreateIdentity(dir);
  eq(second.created, false, "second call did not create it again");
  eq(second.deviceId, first.deviceId, "same deviceId");
  eq(second.publicKeyPem, first.publicKeyPem, "same public key");
  eq(second.createdAtUtc, first.createdAtUtc, "same createdAtUtc -- not regenerated");
});

await check("deviceId is derived from sha256(public key DER)[0:16], base32 -- reproducible from the file alone", async () => {
  const dir = await freshStateDir();
  const identity = await loadOrCreateIdentity(dir);
  const text = await readFile(join(dir, DEVICE_IDENTITY_FILE), "utf8");
  const record = JSON.parse(text);
  eq(record.version, DEVICE_IDENTITY_VERSION, "file records the schema version");
  // Re-derive by hand from the stored public key, independent of the
  // module's own internals, and check it matches what was returned.
  const { createPublicKey } = await import("node:crypto");
  const der = createPublicKey(record.publicKeyPem).export({ type: "spki", format: "der" });
  const hash = createHash("sha256").update(der).digest();
  const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of hash.subarray(0, 16)) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  eq(identity.deviceId, out, "deviceId matches an independent re-derivation");
});

await check("signWithIdentity signs with the SAME key loadOrCreateIdentity reports, and the signature verifies", async () => {
  const dir = await freshStateDir();
  const identity = await loadOrCreateIdentity(dir);
  const message = Buffer.from("a check-in payload's canonical text, stood in for", "utf8");
  const signature = await signWithIdentity(dir, message);
  eq(Buffer.isBuffer(signature), true, "returns a Buffer");
  eq(signature.length, 64, "a raw Ed25519 signature is always 64 bytes");
  const { createPublicKey } = await import("node:crypto");
  const ok = verifyBytes(null, message, createPublicKey(identity.publicKeyPem), signature);
  eq(ok, true, "the signature verifies under the identity's own reported public key");

  const tampered = Buffer.from(message.toString("utf8") + "!", "utf8");
  const notOk = verifyBytes(null, tampered, createPublicKey(identity.publicKeyPem), signature);
  eq(notOk, false, "a changed message fails verification");
});

/* ── refused, never replaced ───────────────────────────────────────────── */

await check("a corrupt (not-JSON) identity file is refused, and left untouched -- never silently regenerated", async () => {
  const dir = await freshStateDir();
  const file = join(dir, DEVICE_IDENTITY_FILE);
  await writeFile(file, "{ this is not json");
  let threw = null;
  try {
    await loadOrCreateIdentity(dir);
  } catch (err) {
    threw = err;
  }
  eq(threw !== null, true, "loadOrCreateIdentity refuses rather than regenerating");
  eq(threw.message.toLowerCase().includes("refused"), true, "the error says it was refused");
  const after = await readFile(file, "utf8");
  eq(after, "{ this is not json", "the corrupt file is byte-for-byte unchanged");
});

await check("a well-formed-JSON file with a deviceId that does not match its own public key is refused (hand-edited or merged from two boxes)", async () => {
  const dir = await freshStateDir();
  const real = await loadOrCreateIdentity(dir);
  const file = join(dir, DEVICE_IDENTITY_FILE);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.deviceId = record.deviceId === "AAAAAAAAAAAAAAAAAAAAAAAAAA" ? "BBBBBBBBBBBBBBBBBBBBBBBBBB" : "AAAAAAAAAAAAAAAAAAAAAAAAAA";
  await writeFile(file, JSON.stringify(record, null, 2));
  let threw = null;
  try {
    await loadOrCreateIdentity(dir);
  } catch (err) {
    threw = err;
  }
  eq(threw !== null, true, "a mismatched deviceId is refused");
  eq(real.deviceId !== record.deviceId, true, "sanity: the test actually changed it");
});

for (const [label, mutate] of [
  ["missing privateKeyPem", (r) => { delete r.privateKeyPem; return r; }],
  ["missing publicKeyPem", (r) => { delete r.publicKeyPem; return r; }],
  ["wrong version", (r) => ({ ...r, version: 999 })],
  ["unparsable createdAtUtc", (r) => ({ ...r, createdAtUtc: "not a date" })],
]) {
  await check(`a structurally broken identity file (${label}) is refused`, async () => {
    const dir = await freshStateDir();
    await loadOrCreateIdentity(dir);
    const file = join(dir, DEVICE_IDENTITY_FILE);
    const record = mutate(JSON.parse(await readFile(file, "utf8")));
    await writeFile(file, JSON.stringify(record, null, 2));
    let threw = null;
    try {
      await loadOrCreateIdentity(dir);
    } catch (err) {
      threw = err;
    }
    eq(threw !== null, true, `refused: ${label}`);
  });
}

/* ── file mode ──────────────────────────────────────────────────────────── */

await check("device-identity.json is written mode 0600 where the OS supports it (skip loudly on Windows)", async () => {
  const dir = await freshStateDir();
  const originalError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    await loadOrCreateIdentity(dir);
  } finally {
    console.error = originalError;
  }
  const st = await stat(join(dir, DEVICE_IDENTITY_FILE));
  if (process.platform === "win32") {
    eq(logged.some((l) => l.toLowerCase().includes("windows")), true, "a loud warning names Windows when the mode could not be applied");
  } else {
    eq(st.mode & 0o777, 0o600, "file mode is exactly 0600");
  }
});

/* ── concurrent creation, same process ─────────────────────────────────── */

await check("concurrent loadOrCreateIdentity calls in ONE process for a fresh stateDir all agree on one identity", async () => {
  const dir = await freshStateDir();
  const results = await Promise.all([loadOrCreateIdentity(dir), loadOrCreateIdentity(dir), loadOrCreateIdentity(dir)]);
  const ids = new Set(results.map((r) => r.deviceId));
  eq(ids.size, 1, "every concurrent caller sees the same deviceId, not several different ones");
  eq(results.filter((r) => r.created).length >= 1, true, "at least one call reports having created it");
});

/* ── concurrent creation, across "processes" (worker threads) ─────────── */

function runInWorker(stateDir, startAtMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./_deviceIdentityWorker.mjs", import.meta.url), { workerData: { stateDir, startAtMs } });
    worker.once("message", (msg) => { resolvePromise(msg); worker.terminate(); });
    worker.once("error", rejectPromise);
  });
}

await check("two workers (standing in for two SEPARATE processes -- no shared JS state at all) racing to create the FIRST identity for a fresh stateDir agree on one deviceId", async () => {
  const dir = await freshStateDir();
  const startAtMs = Date.now() + 150; // give both workers time to spin up and import before racing
  const [a, b] = await Promise.all([runInWorker(dir, startAtMs), runInWorker(dir, startAtMs)]);
  eq(a.ok, true, "worker A succeeded");
  eq(b.ok, true, "worker B succeeded");
  eq(a.deviceId, b.deviceId, "both workers agree on the same deviceId");
  eq(a.publicKeyPem, b.publicKeyPem, "and the same public key");
  eq([a.created, b.created].filter(Boolean).length, 1, "exactly one of the two writes became the file, never both and never neither");

  // The file on disk is the single source of truth both workers had to
  // converge on; check a THIRD, ordinary call agrees with them too.
  const third = await loadOrCreateIdentity(dir);
  eq(third.deviceId, a.deviceId, "a normal call afterward sees the same identity the race settled on");
});

/* ============================ THE FEARED ONE ========================= */

await check("THE FEARED ONE: the device's private key never appears in loadOrCreateIdentity's return value, a refusal's message, or console output", async () => {
  const dir = await freshStateDir();
  const originalError = console.error;
  const originalLog = console.log;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  console.log = (...a) => logged.push(a.join(" "));
  let identity;
  try {
    identity = await loadOrCreateIdentity(dir);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  const file = join(dir, DEVICE_IDENTITY_FILE);
  const record = JSON.parse(await readFile(file, "utf8"));
  const privateKeyMark = record.privateKeyPem; // the real secret, straight from the file it is allowed to live in

  eq(JSON.stringify(identity).includes("PRIVATE KEY"), false, "loadOrCreateIdentity's return value never carries a private key");
  eq(Object.prototype.hasOwnProperty.call(identity, "privateKeyPem"), false, "no privateKeyPem field at all on the returned object");
  for (const line of logged) {
    eq(line.includes(privateKeyMark), false, "console output during creation must not contain the private key");
  }

  // Now force a refusal on a SEPARATE, deliberately corrupted file and make
  // sure that error's own message does not echo the private key it holds.
  const dir2 = await freshStateDir();
  await loadOrCreateIdentity(dir2);
  const file2 = join(dir2, DEVICE_IDENTITY_FILE);
  const record2 = JSON.parse(await readFile(file2, "utf8"));
  const mark2 = `MARK-privkey-${randomBytes(8).toString("hex")}`;
  record2.privateKeyPem = record2.privateKeyPem.replace("Ed25519", mark2); // still garbage enough to fail parsing, keeps the mark inside the file
  record2.privateKeyPem = `${record2.privateKeyPem}\n// ${mark2}`;
  await writeFile(file2, JSON.stringify(record2, null, 2));
  let refusalMessage = "";
  try {
    await loadOrCreateIdentity(dir2);
    throw new Error("expected a refusal");
  } catch (err) {
    refusalMessage = err.message;
  }
  eq(refusalMessage.includes(mark2), false, "a refusal's message must not echo any part of the private key field");
});

/* ── camctl identity / camctl checkin --dry-run ────────────────────────── */

await check("camctl identity: exit 0, creates on first use and says so, shows deviceId and public key, never the private key", async () => {
  const dir = await freshStateDir();
  const r1 = runCamctl("identity", dir);
  eq(r1.status, 0, `exit code (stderr: ${r1.stderr})`);
  eq(r1.stdout.includes("created a new device identity"), true, "says it created one");
  eq(/deviceId:\s+[A-Z2-7]{26}/.test(r1.stdout), true, "prints a deviceId");
  eq(r1.stdout.includes("BEGIN PUBLIC KEY"), true, "prints the public key");
  eq(r1.stdout.includes("PRIVATE KEY"), false, "never prints the private key");
  eq(r1.stderr.includes("PRIVATE KEY"), false, "never on stderr either");

  const r2 = runCamctl("identity", dir);
  eq(r2.status, 0, "second call also exits 0");
  eq(r2.stdout.includes("created a new device identity"), false, "second call does not claim to have created it again");
  const id1 = r1.stdout.match(/deviceId:\s+(\S+)/)[1];
  const id2 = r2.stdout.match(/deviceId:\s+(\S+)/)[1];
  eq(id1, id2, "same deviceId both times");
});

await check("camctl identity on a corrupt file: exit 1, refused, never the (fuzzed) private key on stdout or stderr", async () => {
  const dir = await freshStateDir();
  runCamctl("identity", dir); // create a real one first
  const file = join(dir, DEVICE_IDENTITY_FILE);
  const record = JSON.parse(await readFile(file, "utf8"));
  const mark = `MARK-corrupt-${randomBytes(8).toString("hex")}`;
  record.deviceId = "not-the-real-deviceid-at-all-00000"; // breaks the deviceId/public-key cross-check
  record.note = mark;
  await writeFile(file, JSON.stringify(record, null, 2));

  const r = runCamctl("identity", dir);
  eq(r.status, 1, `refused: exit 1 (stdout: ${r.stdout} stderr: ${r.stderr})`);
  eq((r.stdout + r.stderr).toLowerCase().includes("refused"), true, "says refused");
  eq((r.stdout + r.stderr).includes(record.privateKeyPem), false, "the real private key from the file never appears in output");
  eq((r.stdout + r.stderr).includes(mark), false, "not even an unrelated planted marker leaks through the refusal path");
});

await check("camctl checkin --dry-run: exit 0, prints a payload and signature, sends nothing (no network, no checkin-state.json written)", async () => {
  const dir = await freshStateDir();
  const r = runCamctl("checkin", dir, ["--dry-run"]);
  eq(r.status, 0, `exit code (stderr: ${r.stderr})`);
  eq(r.stdout.includes("dry run -- nothing sent"), true, "says dry run");
  eq(r.stdout.includes('"seq":1'), true, "the very first dry run previews seq 1");
  eq(r.stdout.includes("signature (base64):"), true, "prints a signature");
  eq(/deviceId:\s+\S+/.test(r.stdout), true, "prints a deviceId");

  let stateExists = true;
  try {
    await stat(join(dir, "checkin-state.json"));
  } catch {
    stateExists = false;
  }
  eq(stateExists, false, "a dry run never writes checkin-state.json -- it has no side effects");
});

await check("camctl checkin without --dry-run: exit 2, usage message, nothing sent or written", async () => {
  const dir = await freshStateDir();
  const r = runCamctl("checkin", dir, []);
  eq(r.status, 2, "usage exit code");
  eq(r.stderr.toLowerCase().includes("usage"), true, "prints usage");
});

/* ============================ THE FEARED ONE (camctl) ================ */

await check("THE FEARED ONE (camctl checkin --dry-run): a fuzzed health.json full of camera secrets never reaches stdout or stderr", async () => {
  const dir = await freshStateDir();
  const camUser = `MARK-camUser-${randomBytes(8).toString("hex")}`;
  const camPass = `MARK-camPW-${randomBytes(8).toString("hex")}`;
  await writeFile(
    join(dir, "health.json"),
    JSON.stringify({
      cameraIds: ["cam1"],
      unresolved: [{ cameraId: "cam1", reason: `rtsp://${camUser}:${camPass}@192.168.1.64/Streaming/Channels/101` }],
      lastSealedUtc: {},
      disks: [],
      retentionHours: null, retentionBasis: null, retentionRefused: null,
    }),
  );
  await writeFile(join(dir, "detect-health.json"), JSON.stringify({ cameras: [] }));

  const r = runCamctl("checkin", dir, ["--dry-run"]);
  eq(r.status, 0, `exit code (stderr: ${r.stderr})`);
  const out = r.stdout + r.stderr;
  eq(out.toLowerCase().includes(camUser.toLowerCase()), false, "camera user name never appears in camctl output");
  eq(out.toLowerCase().includes(camPass.toLowerCase()), false, "camera password never appears in camctl output");
  eq(out.includes("rtsp://"), false, "no rtsp URL of any kind appears in camctl output");

  // Also never the box's own private key, planted in the same run.
  const record = JSON.parse(await readFile(join(dir, DEVICE_IDENTITY_FILE), "utf8"));
  eq(out.includes(record.privateKeyPem), false, "the device's own private key never appears either");
});

await rm(root, { recursive: true, force: true });
check("THE SERVICE CAN READ IT: an identity made by root (sudo camctl identity) goes to the state directory's owner", () => {
  // Found 2026-09-23 before it ever ran on the box: root would have kept a
  // 0600 file the camplat service could never read to sign check-ins.
  const camplatDir = { uid: 998, gid: 998 };
  same(identityOwner(0, camplatDir), { uid: 998, gid: 998 }, "root creating it hands it to camplat");
  eq(identityOwner(998, camplatDir), null, "camplat creating it owns it already");
  eq(identityOwner(0, { uid: 0, gid: 0 }), null, "a root-owned state directory: root stays the owner");
  eq(identityOwner(null, camplatDir), null, "no getuid (Windows): left as created");
  eq(identityOwner(0, null), null, "a directory that cannot be read: left as created, never guessed");
});

report("deviceIdentity");
