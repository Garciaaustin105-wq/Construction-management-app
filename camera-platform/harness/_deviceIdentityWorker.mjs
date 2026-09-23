// A worker-thread body used only by harness/deviceIdentity.harness.mjs, to
// simulate a SEPARATE process's module state for the cross-process
// identity-creation race test. A worker thread gets its own V8 isolate and
// its own copy of every ES module (so its own, empty `creating` Map inside
// agent/device-identity.mjs), the same way a second `node` process would --
// but starts in milliseconds instead of the ~100ms+ a real child process
// costs, which matters when the test wants two attempts to land close
// enough in wall-clock time to actually contend for the same lock. What it
// shares with the parent thread and every other worker is the real
// filesystem, which is exactly the thing under test: agent/device-
// identity.mjs's link()-based creation guard has to work across that
// shared filesystem with no shared JS memory at all, precisely as it would
// across two real processes.
import { parentPort, workerData } from "node:worker_threads";
import { loadOrCreateIdentity } from "../agent/device-identity.mjs";

const delay = Math.max(0, workerData.startAtMs - Date.now());
await new Promise((resolve) => setTimeout(resolve, delay));

try {
  const identity = await loadOrCreateIdentity(workerData.stateDir);
  parentPort.postMessage({
    ok: true,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    createdAtUtc: identity.createdAtUtc,
    created: identity.created,
  });
} catch (err) {
  parentPort.postMessage({ ok: false, message: err.message });
}
