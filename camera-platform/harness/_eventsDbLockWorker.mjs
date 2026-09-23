// A worker-thread body used only by harness/eventsDb.harness.mjs, to hold
// events.db's write lock for a controlled duration on a REAL second thread --
// standing in for detect-service, a separate OS process that opens its own
// DatabaseSync handle on the same file (see harness/_checkinWorker.mjs's top
// comment for why a worker thread, not another connection on this same
// thread, is what actually exercises a concurrent lock wait: node:sqlite's
// DatabaseSync is fully synchronous, so two handles opened on one JS thread
// never truly race -- whichever one goes first finishes before the other
// starts. A worker thread is a real second thread, so the parent's own
// synchronous, blocking deleteEndedBefore/upsert calls genuinely wait on it).
//
// Protocol: open the file, BEGIN IMMEDIATE (the write lock detect-service
// would be holding), postMessage "locked" so the parent knows it is safe to
// start its own blocking call, hold for workerData.holdMs, then COMMIT and
// postMessage "released".
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(workerData.file);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
// A real write, not just an open transaction: BEGIN IMMEDIATE alone already
// takes the write lock, but inserting proves this is genuinely the same kind
// of write detect-service makes, not a no-op transaction.
db.exec(`INSERT INTO events (id, camera_id, kind, first_ms, last_ms, count, best_confidence, best_ms, finished)
         VALUES ('lock-holder', 'cam-lock-holder', 'person', 0, 1, 1, 0.5, 0, 0)`);
parentPort.postMessage("locked");

await new Promise((resolve) => setTimeout(resolve, workerData.holdMs));

db.exec("COMMIT");
db.close();
parentPort.postMessage("released");
