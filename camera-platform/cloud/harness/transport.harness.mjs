// cloud/harness/transport.harness.mjs — cloud/contracts/transport.ts
//
// FEARED: a path order that gets reordered or that retries a path already
// attempted this session; a relay path used when the caller said it was not
// allowed (or, just as bad, "give up" for the wrong reason when relay itself
// was tried and failed rather than refused by policy); a "give up" that
// fires while a connected attempt sits unnoticed in the list; and a
// msToConnect that starts the clock from the wrong attempt once more than
// one path was tried before the one that worked.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { nextPath, sessionSummary, relayShare, TRY_BUDGET_MS } from "../dist/cloud/contracts/transport.js";

console.log("transport");

// ---- Fixtures. Every expected value below is written out literally per
// build rule (compute expected values by hand, never by calling the code
// under test).

function A(kind, startedMs, endedMs, outcome, reason = null) {
  return { kind, startedMs, endedMs, outcome, reason };
}

// ---- nextPath ----

check("nextPath: the order is always local, then direct, then relay", () => {
  same(nextPath([], { relayAllowed: true, lanHint: "unknown" }), { try: "local" });
  same(nextPath([A("local", 0, 100, "failed", "x")], { relayAllowed: true, lanHint: "unknown" }), { try: "direct" });
  same(
    nextPath([A("local", 0, 100, "failed", "x"), A("direct", 100, 200, "failed", "y")], {
      relayAllowed: true,
      lanHint: "unknown",
    }),
    { try: "relay" },
  );
  same(
    nextPath(
      [A("local", 0, 100, "failed", "x"), A("direct", 100, 200, "failed", "y"), A("relay", 200, 300, "failed", "z")],
      { relayAllowed: true, lanHint: "unknown" },
    ),
    { give_up: true, reason: "all_paths_failed" },
  );
});

check("nextPath: different_lan skips local", () => {
  same(nextPath([], { relayAllowed: true, lanHint: "different_lan" }), { try: "direct" });
  same(nextPath([A("direct", 0, 100, "failed", null)], { relayAllowed: true, lanHint: "different_lan" }), {
    try: "relay",
  });
  same(
    nextPath([A("direct", 0, 100, "failed", null), A("relay", 100, 200, "failed", null)], {
      relayAllowed: true,
      lanHint: "different_lan",
    }),
    { give_up: true, reason: "all_paths_failed" },
  );
});

check("nextPath: same_lan and unknown both try local first", () => {
  same(nextPath([], { relayAllowed: true, lanHint: "same_lan" }), { try: "local" });
  same(nextPath([], { relayAllowed: false, lanHint: "unknown" }), { try: "local" });
});

check("nextPath: relay is refused when not allowed", () => {
  same(
    nextPath([A("local", 0, 100, "failed", null), A("direct", 100, 200, "failed", null)], {
      relayAllowed: false,
      lanHint: "same_lan",
    }),
    { give_up: true, reason: "relay_not_allowed" },
  );
  same(nextPath([A("direct", 0, 100, "failed", null)], { relayAllowed: false, lanHint: "different_lan" }), {
    give_up: true,
    reason: "relay_not_allowed",
  });
});

check("nextPath: relay already attempted (even when disallowed) is all_paths_failed, not relay_not_allowed", () => {
  same(
    nextPath(
      [A("local", 0, 100, "failed", null), A("direct", 100, 200, "failed", null), A("relay", 200, 300, "failed", null)],
      { relayAllowed: false, lanHint: "same_lan" },
    ),
    { give_up: true, reason: "all_paths_failed" },
  );
});

check("nextPath: already_connected wins over any remaining paths", () => {
  same(nextPath([A("direct", 0, 100, "connected", null)], { relayAllowed: true, lanHint: "same_lan" }), {
    give_up: true,
    reason: "already_connected",
  });
  same(
    nextPath([A("local", 0, 50, "failed", null), A("direct", 50, 150, "connected", null)], {
      relayAllowed: false,
      lanHint: "different_lan",
    }),
    { give_up: true, reason: "already_connected" },
  );
});

check("nextPath: all_paths_failed with timeouts, not just failures", () => {
  same(
    nextPath(
      [
        A("local", 0, 1500, "timeout", null),
        A("direct", 1500, 7500, "timeout", null),
        A("relay", 7500, 15500, "timeout", null),
      ],
      { relayAllowed: true, lanHint: "unknown" },
    ),
    { give_up: true, reason: "all_paths_failed" },
  );
});

// ---- sessionSummary ----

check("sessionSummary: timing runs from the first attempt to the one that connected", () => {
  same(
    sessionSummary([
      A("local", 1000, 2500, "failed", null),
      A("direct", 2500, 9000, "failed", null),
      A("relay", 9000, 15000, "connected", null),
    ]),
    { connectedVia: "relay", triedInOrder: ["local", "direct", "relay"], msToConnect: 14000, relayUsed: true },
  );
});

check("sessionSummary: a single connected attempt", () => {
  same(sessionSummary([A("local", 500, 1200, "connected", null)]), {
    connectedVia: "local",
    triedInOrder: ["local"],
    msToConnect: 700,
    relayUsed: false,
  });
});

check("sessionSummary: nothing connected gives a null connectedVia and msToConnect", () => {
  same(sessionSummary([A("local", 0, 1500, "timeout", null), A("direct", 1500, 7500, "failed", "refused")]), {
    connectedVia: null,
    triedInOrder: ["local", "direct"],
    msToConnect: null,
    relayUsed: false,
  });
});

check("sessionSummary: no attempts at all", () => {
  same(sessionSummary([]), { connectedVia: null, triedInOrder: [], msToConnect: null, relayUsed: false });
});

// ---- relayShare ----

check("relayShare: null share with no sessions, never 0", () => {
  same(relayShare([]), { sessions: 0, relay: 0, share: null });
});

check("relayShare: counts relay-connected sessions and divides", () => {
  const local = { connectedVia: "local", triedInOrder: ["local"], msToConnect: 100, relayUsed: false };
  const relay = { connectedVia: "relay", triedInOrder: ["local", "direct", "relay"], msToConnect: 5000, relayUsed: true };
  const none = { connectedVia: null, triedInOrder: ["local", "direct", "relay"], msToConnect: null, relayUsed: false };
  same(relayShare([local, relay, none]), { sessions: 3, relay: 1, share: 1 / 3 });
});

// ---- TRY_BUDGET_MS ----

check("TRY_BUDGET_MS: local=1500ms, direct=6000ms, relay=8000ms (milliseconds, not seconds)", () => {
  same(TRY_BUDGET_MS, { local: 1500, direct: 6000, relay: 8000 });
});

// ---- sessionSummary tie-break ----

check("sessionSummary: two connected attempts, the first in attempts order wins", () => {
  same(
    sessionSummary([
      A("direct", 1000, 3000, "connected", null),
      A("relay", 3000, 5000, "connected", null),
    ]),
    { connectedVia: "direct", triedInOrder: ["direct", "relay"], msToConnect: 2000, relayUsed: false },
  );
});

report("transport");
