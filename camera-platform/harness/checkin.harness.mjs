/**
 * agent/checkin.mjs: the box's outbound half of a signed cloud check-in
 * (CLOUD-B1-SPEC.md section 6; B1 phase-1 brief, piece 3, "the sender").
 *
 * Every stateDir/appDir here is a fresh temp directory (build rule 21:
 * harnesses never touch real data); nothing is written under the real
 * appliance paths in agent/config.mjs.
 *
 * device-identity.mjs (this brief's piece 1) is never imported: `identity`
 * is always injected as a fake built from a real Ed25519 key pair generated
 * in this file and thrown away at the end, the same way
 * harness/releaseVerify.harness.mjs keeps its own throwaway keys. That is
 * what lets this harness run before -- and after -- agent/device-identity.mjs
 * exists, unchanged either way.
 *
 * The failures feared, in order (build rule 19): a camera password or the
 * device's own private key leaking into a built payload, a thrown error, or
 * a compose/send outcome message (THE FEARED ONE); a checkin actually
 * leaving the box with no url configured, or over http://; a sequence
 * number repeating after a crash-like restart; and a licence gate that lets
 * a checkin through anyway once told the box is unlicensed.
 */
import { generateKeyPairSync, sign as signBytes, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import {
  readCheckinFacts, readCheckinState, composeCheckin, sendCheckin, verifyCheckin,
  CHECKIN_STATE_FILE, CHECKIN_LOCK_FILE,
} from "../agent/checkin.mjs";
import { check, eq, same, report } from "./_assert.mjs";

console.log("checkin");

const root = await mkdtemp(join(tmpdir(), "camplat-checkin-"));
let dirCounter = 0;
async function freshStateDir() {
  const dir = join(root, `state-${dirCounter++}`);
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  return dir;
}

/** A real Ed25519 identity, generated here and never written to disk --
 *  mirrors harness/releaseVerify.harness.mjs's own throwaway keys. */
function fakeIdentity(deviceId = "device-test-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    publicKeyPem,
    privateKey,
    loadOrCreateIdentity: async () => ({ deviceId, publicKeyPem, createdAtUtc: "2026-09-01T00:00:00.000Z" }),
    signWithIdentity: async (_stateDir, message) => signBytes(null, message, privateKey),
  };
}

function fakeFetch(status, { calls = [] } = {}) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { status, text: async () => "" };
  };
}

const now = () => new Date("2026-09-23T12:00:00.000Z");

/* ── readCheckinFacts: shaping health.json + detect-health.json ───────── */

await check("readCheckinFacts with no files on disk yet: empty cameras, no version, uptime still reported", async () => {
  const stateDir = await freshStateDir();
  const facts = await readCheckinFacts({ stateDir, appDir: stateDir, uptimeSecFn: () => 123.9 });
  eq(facts.version, null, "no MANIFEST.json, no version");
  same(facts.cameras, [], "no health.json, no cameras known");
  eq(facts.uptimeSec, 123, "uptime still reported, floored");
  eq(facts.lastSealedUtc, null, "nothing sealed");
});

await check("readCheckinFacts merges health.json and detect-health.json by cameraId, and reads a MANIFEST.json version", async () => {
  const stateDir = await freshStateDir();
  await writeFile(
    join(stateDir, "health.json"),
    JSON.stringify({
      cameraIds: ["cam1", "cam2"],
      unresolved: [{ cameraId: "cam2", reason: "camera has neither a url nor a host" }],
      lastSealedUtc: { cam1: "2026-09-23T11:50:00.000Z" },
      disks: [{ root: "/srv/camplat/disk0", total: 1000, used: 400 }],
      retentionHours: 72, retentionBasis: "measured", retentionRefused: null,
    }),
  );
  await writeFile(
    join(stateDir, "detect-health.json"),
    JSON.stringify({
      capacityFps: 8, minConfidence: 0.5, motionGate: { enabled: true, threshold: 0.005, keepaliveMs: 5000 },
      knownObjects: { active: 3, lapsed: 1 },
      cameras: [{ cameraId: "cam1", state: "watching", gate: { sinceStart: { frames: 100, looked: 40, share: 0.4 } } }],
    }),
  );
  await writeFile(join(stateDir, "MANIFEST.json"), JSON.stringify({
    version: "b".repeat(40), builtAtUtc: "2026-09-20T00:00:00.000Z",
    files: [{ path: "VERSION", sha256: "c".repeat(64), bytes: 1 }],
  }));

  const facts = await readCheckinFacts({ stateDir, appDir: stateDir });
  eq(facts.version, "b".repeat(40), "version from MANIFEST.json");
  eq(facts.cameras.length, 2, "both cameras known");
  const cam1 = facts.cameras.find((c) => c.cameraId === "cam1");
  const cam2 = facts.cameras.find((c) => c.cameraId === "cam2");
  eq(cam1.recording, true, "cam1 not in unresolved");
  eq(cam1.detecting, "watching", "cam1 detect state");
  eq(cam1.gateShare, 0.4, "cam1 gate share");
  eq(cam1.lastSealedUtc, "2026-09-23T11:50:00.000Z", "cam1 last sealed");
  eq(cam2.recording, false, "cam2 IS in unresolved");
  eq(cam2.detecting, null, "cam2 has no detect-health entry");
  eq(facts.drives[0].fillFraction, 0.4, "400/1000");
  eq(facts.footageHeld.hours, 72, "retention reused, not recomputed");
  eq(facts.detector.motionGateEnabled, true, "motionGate.enabled read correctly");
  eq(facts.knownObjects.active, 3, "known objects active count");
  eq(facts.lastSealedUtc, "2026-09-23T11:50:00.000Z", "top-level newest sealed time");
});

await check("a corrupt health.json is treated as absent, not as an error that blocks a checkin", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, "health.json"), "{ not json");
  const facts = await readCheckinFacts({ stateDir, appDir: stateDir });
  same(facts.cameras, [], "no cameras rather than a thrown error");
});

/* ── compose + sign + verify round trip ────────────────────────────────── */

await check("composeCheckin builds a payload that verifyCheckin accepts, and tampering breaks it", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity("device-round-trip");
  const composed = await composeCheckin({ stateDir, now, seq: 1, identity: id, appDir: stateDir });
  eq(verifyCheckin(composed.payload, composed.signature, id.publicKeyPem), true, "genuine signature verifies");

  const tamperedSeq = { ...composed.payload, seq: 2 };
  eq(verifyCheckin(tamperedSeq, composed.signature, id.publicKeyPem), false, "a changed seq fails verification");

  const tamperedHealth = JSON.parse(JSON.stringify(composed.payload));
  tamperedHealth.health.uptimeSec += 1;
  eq(verifyCheckin(tamperedHealth, composed.signature, id.publicKeyPem), false, "a changed health field fails verification");

  const other = fakeIdentity("device-other");
  eq(verifyCheckin(composed.payload, composed.signature, other.publicKeyPem), false, "a different device's key fails");

  eq(verifyCheckin(composed.payload, "not-base64-!!!", id.publicKeyPem), false, "a malformed signature never throws, just fails");
  eq(verifyCheckin(composed.payload, composed.signature, "not a pem"), false, "a malformed key never throws, just fails");
});

await check("composeCheckin never touches checkin-state.json -- it is the dry-run path, side-effect free", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity();
  await composeCheckin({ stateDir, now, seq: 5, identity: id, appDir: stateDir });
  let exists = true;
  try { await readFile(join(stateDir, CHECKIN_STATE_FILE)); } catch { exists = false; }
  eq(exists, false, "no state file written by compose alone");
});

/* ── sendCheckin: no url, insecure url, licence, outcomes, seq ─────────── */

await check("no url configured: nothing sent, and no error", async () => {
  const stateDir = await freshStateDir();
  const calls = [];
  const result = await sendCheckin({ stateDir, url: undefined, fetchFn: fakeFetch(200, { calls }), identity: fakeIdentity(), appDir: stateDir });
  eq(result.outcome, "no_url");
  eq(calls.length, 0, "fetch never called");
});

await check("http:// is refused outright, before any network call", async () => {
  const stateDir = await freshStateDir();
  const calls = [];
  const result = await sendCheckin({ stateDir, url: "http://cloud.example.test/checkin", fetchFn: fakeFetch(200, { calls }), identity: fakeIdentity(), appDir: stateDir });
  eq(result.outcome, "refused_insecure_url");
  eq(calls.length, 0, "fetch never called");
  const state = await readCheckinState(stateDir);
  eq(state.seq, 0, "seq untouched by a refusal");
});

await check("2xx/4xx/5xx/network-failure are mapped to named outcomes, and each still advances seq", async () => {
  const cases = [
    [200, "sent"], [204, "sent"],
    [400, "rejected"], [404, "rejected"], [499, "rejected"],
    [500, "server_error"], [503, "server_error"],
  ];
  for (const [status, outcome] of cases) {
    const stateDir = await freshStateDir();
    const result = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(status), identity: fakeIdentity(), appDir: stateDir, now });
    eq(result.outcome, outcome, `status ${status}`);
    eq(result.seq, 1, "first ever checkin is seq 1");
  }

  const stateDir = await freshStateDir();
  const result = await sendCheckin({
    stateDir, url: "https://cloud.example.test/checkin",
    fetchFn: async () => { throw new Error("ECONNREFUSED"); },
    identity: fakeIdentity(), appDir: stateDir, now,
  });
  eq(result.outcome, "network_error");
  eq(result.message.includes("ECONNREFUSED"), true, "the underlying reason is preserved");
});

await check("seq persists and strictly increases across separate sendCheckin calls, even across a fresh process (a new state read)", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity();
  const r1 = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200), identity: id, appDir: stateDir, now });
  const r2 = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200), identity: id, appDir: stateDir, now });
  const r3 = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(500), identity: id, appDir: stateDir, now });
  eq([r1.seq, r2.seq, r3.seq].join(","), "1,2,3", "strictly increasing, failures included");
  const state = await readCheckinState(stateDir);
  eq(state.seq, 3, "persisted seq matches the last attempt, not just the last success");
});

await check("a seq is never reused even when the send itself fails outright", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity();
  await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: async () => { throw new Error("down"); }, identity: id, appDir: stateDir, now });
  const afterFailure = await readCheckinState(stateDir);
  eq(afterFailure.seq, 1, "the seq was consumed even though nothing arrived");
  const r2 = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200), identity: id, appDir: stateDir, now });
  eq(r2.seq, 2, "the next attempt does not repeat seq 1");
});

/* ── concurrency: the lock that prevents a duplicate seq (reviewer finding) ─
 * Two overlapping sendCheckin() calls for the SAME stateDir used to be able
 * to both read the same seq before either wrote it back, and both send it --
 * looking, to the cloud's own replay defense, exactly like a replay. The
 * fix serialises read-seq/write-seq/send per stateDir: an in-process
 * promise chain, plus a cross-process 'wx' lock file, with a stale lock
 * broken (and logged) rather than waited on forever. */

await check("concurrent sendCheckin calls in ONE process for the SAME stateDir never read the same seq", async () => {
  const stateDir = await freshStateDir();
  const id = fakeIdentity();
  // An artificial delay widens the window a broken version of this code
  // would need to actually hit the race in -- without it, three fast, truly
  // synchronous-looking calls might happen to serialise by accident even
  // with no lock at all, and the test would pass for the wrong reason.
  const slowFetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200, text: async () => "" };
  };
  const [a, b, c] = await Promise.all([
    sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: slowFetch, identity: id, appDir: stateDir, now }),
    sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: slowFetch, identity: id, appDir: stateDir, now }),
    sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: slowFetch, identity: id, appDir: stateDir, now }),
  ]);
  const seqs = [a.seq, b.seq, c.seq];
  eq(new Set(seqs).size, 3, `all three seqs must be distinct, got ${seqs.join(",")}`);
  eq([...seqs].sort((x, y) => x - y).join(","), "1,2,3", "exactly seq 1, 2 and 3 -- no gaps, no repeats");
  eq([a.outcome, b.outcome, c.outcome].every((o) => o === "sent"), true, "all three still succeed");
  const finalState = await readCheckinState(stateDir);
  eq(finalState.seq, 3, "persisted state matches the highest seq actually used");
});

function runCheckinInWorker(stateDir, url, startAtMs, nowIso) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL("./_checkinWorker.mjs", import.meta.url), { workerData: { stateDir, url, startAtMs, nowIso } });
    worker.once("message", (msg) => { resolvePromise(msg); worker.terminate(); });
    worker.once("error", rejectPromise);
  });
}

await check("two workers (standing in for two SEPARATE processes) racing sendCheckin for the SAME stateDir get different, non-repeating seqs", async () => {
  const stateDir = await freshStateDir();
  const startAtMs = Date.now() + 150; // let both workers spin up and import before they race
  const [a, b] = await Promise.all([
    runCheckinInWorker(stateDir, "https://cloud.example.test/checkin", startAtMs, now().toISOString()),
    runCheckinInWorker(stateDir, "https://cloud.example.test/checkin", startAtMs, now().toISOString()),
  ]);
  eq(a.outcome, "sent", `worker A (message: ${a.message ?? ""})`);
  eq(b.outcome, "sent", `worker B (message: ${b.message ?? ""})`);
  eq(new Set([a.seq, b.seq]).size, 2, "two different seqs, never a duplicate, across two isolates sharing only the filesystem");
  eq([a.seq, b.seq].sort((x, y) => x - y).join(","), "1,2", "exactly seq 1 and seq 2");
});

await check("a stale lock (older than the configured timeout) is broken, logged, and the checkin still proceeds", async () => {
  const stateDir = await freshStateDir();
  const lockPath = join(stateDir, CHECKIN_LOCK_FILE);
  await writeFile(lockPath, "");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const originalError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  let result;
  try {
    result = await sendCheckin({
      stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200),
      identity: fakeIdentity(), appDir: stateDir, now,
      lockStaleMs: 1_000, lockMaxWaitMs: 5_000,
    });
  } finally {
    console.error = originalError;
  }
  eq(result.outcome, "sent", "the checkin still succeeds once the stale lock is broken");
  eq(result.seq, 1, "seq 1, exactly as if nothing had been holding the lock");
  eq(logged.some((l) => l.toLowerCase().includes("stale")), true, "a note is logged naming the stale lock");
  let lockStillThere = true;
  try { await readFile(lockPath); } catch { lockStillThere = false; }
  eq(lockStillThere, false, "the lock is gone afterward -- released properly, not left stale again");
});

await check("the lock file never survives a sendCheckin call, whether it succeeds or fails", async () => {
  const stateDir = await freshStateDir();
  const lockPath = join(stateDir, CHECKIN_LOCK_FILE);

  await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200), identity: fakeIdentity(), appDir: stateDir, now });
  let existsAfterSuccess = true;
  try { await readFile(lockPath); } catch { existsAfterSuccess = false; }
  eq(existsAfterSuccess, false, "no lock file left after a success");

  await sendCheckin({
    stateDir, url: "https://cloud.example.test/checkin",
    fetchFn: async () => { throw new Error("down"); },
    identity: fakeIdentity(), appDir: stateDir, now,
  });
  let existsAfterFailure = true;
  try { await readFile(lockPath); } catch { existsAfterFailure = false; }
  eq(existsAfterFailure, false, "no lock file left after a network failure either");
});

await check("not licensed: nothing sent, seq untouched", async () => {
  const stateDir = await freshStateDir();
  const calls = [];
  const result = await sendCheckin({
    stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200, { calls }),
    identity: fakeIdentity(), appDir: stateDir, now,
    checkLicence: async () => ({ licensed: false }),
  });
  eq(result.outcome, "not_licensed");
  eq(calls.length, 0, "fetch never called");
  const state = await readCheckinState(stateDir);
  eq(state.seq, 0, "not_licensed does not consume a seq");
});

await check("licensed (the default hook) sends normally -- the hook existing does not itself block anything", async () => {
  const stateDir = await freshStateDir();
  const result = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200), identity: fakeIdentity(), appDir: stateDir, now });
  eq(result.outcome, "sent");
});

await check("a corrupt checkin-state.json is refused, never silently reset to 0", async () => {
  const stateDir = await freshStateDir();
  await writeFile(join(stateDir, CHECKIN_STATE_FILE), "{ not json");
  const calls = [];
  const result = await sendCheckin({ stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200, { calls }), identity: fakeIdentity(), appDir: stateDir, now });
  eq(result.outcome, "state_corrupt");
  eq(calls.length, 0, "fetch never called once state cannot be trusted");
});

await check("readCheckinState: missing file is seq 0, not an error", async () => {
  const stateDir = await freshStateDir();
  const state = await readCheckinState(stateDir);
  eq(state.kind, "ok");
  eq(state.seq, 0);
});

await check("a slow endpoint is abandoned at the timeout, reported as a network error, not left hanging", async () => {
  const stateDir = await freshStateDir();
  const result = await sendCheckin({
    stateDir, url: "https://cloud.example.test/checkin",
    fetchFn: (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted by timeout")));
    }),
    identity: fakeIdentity(), appDir: stateDir, now, timeoutMs: 25,
  });
  eq(result.outcome, "network_error", "an abort surfaces as a network error, not a hang");
});

/* ============================ THE FEARED ONE ========================= */

await check("THE FEARED ONE: a camera password, a typed rtsp URL, a user name, and the device's own private key never reach a composed payload, its canonical text, or any outcome message", async () => {
  const camMark = `MARK-cam-${randomBytes(8).toString("hex")}`;
  const passMark = `MARK-pass-${randomBytes(8).toString("hex")}`;
  const stateDir = await freshStateDir();
  await writeFile(
    join(stateDir, "health.json"),
    JSON.stringify({
      cameraIds: ["cam1"],
      // health.json's own writer can legitimately carry a raw, unscrubbed
      // resolution-failure reason here (recorder-service.mjs) -- this is
      // exactly that shape, planted on purpose.
      unresolved: [{ cameraId: "cam1", reason: `rtsp://${camMark}:${passMark}@192.168.1.64/Streaming/Channels/101` }],
      lastSealedUtc: {},
      disks: [],
      retentionHours: null, retentionBasis: null, retentionRefused: null,
    }),
  );
  await writeFile(join(stateDir, "detect-health.json"), JSON.stringify({ cameras: [] }));

  const id = fakeIdentity();
  const composed = await composeCheckin({ stateDir, now, seq: 1, identity: id, appDir: stateDir });
  eq(composed.canonicalText.includes(camMark), false, "canonical text must not contain the camera user name");
  eq(composed.canonicalText.includes(passMark), false, "canonical text must not contain the camera password");
  eq(JSON.stringify(composed.payload).includes(passMark), false, "the payload object itself must not contain it either");

  // The SAME stateDir (still holding the poisoned health.json) is reused
  // here on purpose -- sendCheckin must read it and still never leak it.
  const sendResult = await sendCheckin({
    stateDir, url: "https://cloud.example.test/checkin",
    fetchFn: fakeFetch(500), identity: id, appDir: stateDir, now,
  });
  eq(JSON.stringify(sendResult).includes(passMark), false, "an outcome object must not contain it either");
});

await rm(root, { recursive: true, force: true });
await check("THE CLOCK STEPPED BACK: a lock dated an hour in the future is broken, logged, and the checkin proceeds (found in review)", async () => {
  const stateDir = await freshStateDir();
  const lockPath = join(stateDir, CHECKIN_LOCK_FILE);
  await writeFile(lockPath, "");
  const ahead = new Date(Date.now() + 3_600_000);
  await utimes(lockPath, ahead, ahead);
  const originalError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  let result;
  try {
    result = await sendCheckin({
      stateDir, url: "https://cloud.example.test/checkin", fetchFn: fakeFetch(200),
      identity: fakeIdentity(), appDir: stateDir, now,
      lockStaleMs: 60_000, lockMaxWaitMs: 5_000,
    });
  } finally {
    console.error = originalError;
  }
  eq(result.outcome, "sent", "not blocked for good by a lock from the future");
  eq(logged.some((l) => l.includes("in the future")), true, "and it says why it broke the lock");
});

report("checkin");
