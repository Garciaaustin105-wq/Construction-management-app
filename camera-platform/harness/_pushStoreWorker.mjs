// A worker-thread body used only by harness/pushStore.harness.mjs, to
// simulate a SEPARATE process's module state for the cross-process VAPID
// creation race test. Mirrors harness/_deviceIdentityWorker.mjs's own
// comment: a worker thread gets its own V8 isolate and its own copy of
// every ES module (so its own, empty `creatingVapid` Map inside agent/
// push-store.mjs), the same way a second `node` process would, while
// sharing the real filesystem -- exactly the thing under test.
import { parentPort, workerData } from "node:worker_threads";
import { loadOrCreatePublicVapidKey } from "../agent/push-store.mjs";

const delay = Math.max(0, workerData.startAtMs - Date.now());
await new Promise((resolve) => setTimeout(resolve, delay));

try {
  const identity = await loadOrCreatePublicVapidKey(workerData.stateDir);
  parentPort.postMessage({
    ok: true,
    publicKey: identity.publicKey.toString("base64url"),
    createdUtc: identity.createdUtc,
    created: identity.created,
  });
} catch (err) {
  parentPort.postMessage({ ok: false, message: err.message });
}
