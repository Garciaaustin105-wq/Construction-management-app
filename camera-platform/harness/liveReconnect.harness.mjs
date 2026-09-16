/** Reconnecting a live tile (agent/ui/live-client.mjs reconnectDelayMs).
 *  THE FEARED FAILURES: a tight retry loop that floods the recorder, and
 *  retrying forever something that can never work. */
import {
  reconnectDelayMs, RECONNECT_FIRST_MS, RECONNECT_MAX_MS, RECONNECT_REASONS,
} from "../agent/ui/live-client.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("liveReconnect");

check("constants", () => {
  eq([RECONNECT_FIRST_MS, RECONNECT_MAX_MS], [2000, 30000], "2 s first, 30 s at most");
  eq([...RECONNECT_REASONS], ["closed", "stalled", "ended", "source_failed", "mainstream_failed"], "reasons");
  eq(Object.isFrozen(RECONNECT_REASONS), true, "frozen");
});

check("backs off, and never faster than 2 s", () => {
  eq([0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelayMs("closed", a)),
    [2000, 4000, 8000, 16000, 30000, 30000, 30000], "doubling to the cap");
  for (const r of RECONNECT_REASONS) eq(reconnectDelayMs(r, 0), 2000, r);
});

check("THE FEARED ONE: a long outage never turns into a tight loop or a broken timer", () => {
  for (const a of [40, 1024, 1e6, Number.MAX_SAFE_INTEGER]) {
    eq(reconnectDelayMs("closed", a), 30000, `attempt ${a}`);
  }
  for (const a of [-1, 1.5, NaN, Infinity, "3", null, undefined]) {
    eq(reconnectDelayMs("stalled", a), 30000, `bad attempt ${String(a)}`);
  }
});

check("THE FEARED ONE: what can never work is not retried", () => {
  for (const r of ["codec_unsupported", "codec_unreadable", "", "CLOSED", null, undefined, 3, {}]) {
    eq(reconnectDelayMs(r, 0), null, `reason ${String(r)}`);
  }
});

report("live reconnect");
