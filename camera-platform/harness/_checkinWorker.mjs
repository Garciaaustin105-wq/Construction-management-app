// A worker-thread body used only by harness/checkin.harness.mjs to simulate
// a SEPARATE process's module state for the cross-process sendCheckin()
// race test -- see harness/_deviceIdentityWorker.mjs's top comment for why
// a worker thread stands in for a real second process here (a fresh V8
// isolate, so a fresh, unshared inProcessChains Map inside agent/
// checkin.mjs, while still sharing the real filesystem -- including
// agent/checkin.mjs's own cross-process lock file -- with the parent thread
// and any other worker). Uses the REAL agent/device-identity.mjs (no
// injected `identity`), so this also doubles as an integration check that
// the two pieces (device identity, checkin) race-guard correctly together.
import { parentPort, workerData } from "node:worker_threads";
import { sendCheckin } from "../agent/checkin.mjs";

const fetchFn = async () => ({ status: 200, text: async () => "" });
const now = () => new Date(workerData.nowIso);

const delay = Math.max(0, workerData.startAtMs - Date.now());
await new Promise((resolve) => setTimeout(resolve, delay));

const result = await sendCheckin({ stateDir: workerData.stateDir, url: workerData.url, fetchFn, now });
parentPort.postMessage(result);
