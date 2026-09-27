// cloud/harness/accessLog.harness.mjs — cloud/contracts/accessLog.ts
//
// FEARED: a credential-shaped string (an rtsp URL, a password= fragment, a
// bare token) slipping through checkAccessEntry into a log a customer or an
// installer can read; redactForInstaller stripping a cameraId it was never
// asked to touch (or, worse, leaving one exposed after a privacy block); and
// summarize double-counting or dropping an entry that sits exactly on a
// window edge, or reporting a relayShare of 0 for a window that had no video
// access to measure in the first place.

import { check, same, close, report } from "../../harness/_assert.mjs";
import { checkAccessEntry, redactForInstaller, summarize } from "../dist/cloud/contracts/accessLog.js";

console.log("accessLog");

// ---- Fixtures. Every expected value below is written out literally per
// build rule (compute expected values by hand, never by calling the code
// under test).

function entry(overrides = {}) {
  return {
    atMs: 1000,
    userId: "user-1",
    role: "owner",
    action: "live_view",
    siteId: "site-1",
    cameraId: "cam-1",
    transport: "local",
    ok: true,
    reason: null,
    ...overrides,
  };
}

// ---- checkAccessEntry: each reason ----

check("checkAccessEntry: a well-formed entry has no problems", () => {
  same(checkAccessEntry(entry()), []);
});

check("checkAccessEntry: bad_time for a non-integer, non-finite atMs", () => {
  same(checkAccessEntry(entry({ atMs: 1.5 })), ["bad_time"]);
  same(checkAccessEntry(entry({ atMs: NaN })), ["bad_time"]);
  same(checkAccessEntry(entry({ atMs: Infinity })), ["bad_time"]);
});

check("checkAccessEntry: bad_user for an empty userId or role", () => {
  same(checkAccessEntry(entry({ userId: "" })), ["bad_user"]);
  same(checkAccessEntry(entry({ role: "" })), ["bad_user"]);
});

check("checkAccessEntry: bad_action for a value outside the seven actions", () => {
  same(checkAccessEntry(entry({ action: "delete_everything" })), ["bad_action"]);
});

check("checkAccessEntry: bad_site for an empty siteId", () => {
  same(checkAccessEntry(entry({ siteId: "" })), ["bad_site"]);
});

check("checkAccessEntry: bad_transport for a video action with a null transport", () => {
  same(checkAccessEntry(entry({ action: "live_view", transport: null })), ["bad_transport"]);
  same(checkAccessEntry(entry({ action: "playback", transport: null })), ["bad_transport"]);
  same(checkAccessEntry(entry({ action: "export", transport: null })), ["bad_transport"]);
  same(checkAccessEntry(entry({ action: "snapshot", transport: null })), ["bad_transport"]);
});

check("checkAccessEntry: bad_transport for a non-video action carrying a transport", () => {
  same(checkAccessEntry(entry({ action: "login", transport: "local", cameraId: null })), ["bad_transport"]);
  same(checkAccessEntry(entry({ action: "claim", transport: "relay", cameraId: null })), ["bad_transport"]);
  same(checkAccessEntry(entry({ action: "settings_change", transport: "direct", cameraId: null })), ["bad_transport"]);
});

check("checkAccessEntry: bad_transport is skipped when the action itself is bad_action", () => {
  // No valid action to classify as video-or-not, so checking transport
  // consistency would only manufacture a second, meaningless problem.
  same(checkAccessEntry(entry({ action: "nonsense", transport: null })), ["bad_action"]);
});

check("checkAccessEntry: multiple problems are all reported, in the fixed order", () => {
  same(
    checkAccessEntry(
      entry({ atMs: NaN, userId: "", siteId: "", action: "live_view", transport: null, reason: "rtsp://cam.local" }),
    ),
    ["bad_time", "bad_user", "bad_site", "bad_transport", "secret_like"],
  );
});

// ---- checkAccessEntry: secret_like ----

check("checkAccessEntry: an rtsp URL in any string field gives secret_like", () => {
  same(checkAccessEntry(entry({ reason: "leaked rtsp://192.168.1.10/stream1" })), ["secret_like"]);
  same(checkAccessEntry(entry({ userId: "rtsp://192.168.1.10/stream1" })), ["secret_like"]);
});

check("checkAccessEntry: a password= fragment in any string field gives secret_like", () => {
  same(checkAccessEntry(entry({ reason: "retry with password=abc123xyz" })), ["secret_like"]);
});

check("checkAccessEntry: an '@' inside a URL-like string gives secret_like", () => {
  same(checkAccessEntry(entry({ reason: "proxied via http://admin@10.0.0.5/api" })), ["secret_like"]);
});

check("checkAccessEntry: a plain '@' with no '://' nearby is NOT secret_like on its own", () => {
  same(checkAccessEntry(entry({ userId: "installer@example.com" })), []);
});

check("checkAccessEntry: a 40+ character base64-ish run gives secret_like", () => {
  const longRun = "A".repeat(40);
  same(checkAccessEntry(entry({ reason: `token=${longRun}` })), ["secret_like"]);
});

check("checkAccessEntry: a base64-ish run under 40 characters is NOT secret_like on its own", () => {
  const shortRun = "A".repeat(39);
  same(checkAccessEntry(entry({ reason: `token=${shortRun}` })), []);
});

// ---- redactForInstaller ----

check("redactForInstaller: not blocked returns an unchanged copy, not the same object", () => {
  const e = entry({ action: "playback", cameraId: "cam-9" });
  const result = redactForInstaller(e, false);
  same(result, e);
  if (result === e) throw new Error("expected a new object, got the same reference back");
});

check("redactForInstaller: blocked redacts cameraId for a video action", () => {
  const e = entry({ action: "export", cameraId: "cam-9" });
  const result = redactForInstaller(e, true);
  same(result, { ...e, cameraId: null });
});

check("redactForInstaller: blocked leaves a non-video action's cameraId alone", () => {
  const e = entry({ action: "login", transport: null, cameraId: null });
  const result = redactForInstaller(e, true);
  same(result, e);
});

check("redactForInstaller: blocked with an already-null cameraId stays null", () => {
  const e = entry({ action: "live_view", cameraId: null });
  const result = redactForInstaller(e, true);
  same(result, e);
});

// ---- summarize: window edges ----

check("summarize: the window is half-open -- fromMs included, toMs excluded", () => {
  const beforeWindow = entry({ atMs: 999, action: "live_view", transport: "local" });
  const atFrom = entry({ atMs: 1000, action: "live_view", transport: "local" });
  const middle = entry({ atMs: 1500, action: "playback", transport: "relay" });
  const nearEnd = entry({ atMs: 1999, action: "export", transport: "direct" });
  const atTo = entry({ atMs: 2000, action: "snapshot", transport: "relay" });
  const nonVideoMiddle = entry({ action: "login", atMs: 1600, transport: null, cameraId: null });

  const result = summarize(
    [beforeWindow, atFrom, middle, nearEnd, atTo, nonVideoMiddle],
    1000,
    2000,
  );

  same(result.total, 4, "total"); // atFrom, middle, nearEnd, nonVideoMiddle -- not beforeWindow or atTo
  same(
    result.byAction,
    { live_view: 1, playback: 1, export: 1, snapshot: 0, settings_change: 0, claim: 0, login: 1 },
    "byAction",
  );
  same(result.byTransport, { local: 1, direct: 1, relay: 1, none: 1 }, "byTransport");
  close(result.relayShare, 1 / 3, 1e-9, "relayShare");
});

// ---- summarize: relayShare null with no video ----

check("summarize: relayShare is null when the window has no video actions", () => {
  const loginEntry = entry({ action: "login", atMs: 1000, transport: null, cameraId: null });
  const claimEntry = entry({ action: "claim", atMs: 1500, transport: null, cameraId: null });

  const result = summarize([loginEntry, claimEntry], 1000, 2000);

  same(result.total, 2, "total");
  same(
    result.byAction,
    { live_view: 0, playback: 0, export: 0, snapshot: 0, settings_change: 0, claim: 1, login: 1 },
    "byAction",
  );
  same(result.byTransport, { local: 0, direct: 0, relay: 0, none: 2 }, "byTransport");
  same(result.relayShare, null, "relayShare");
});

// ---- checkAccessEntry: secret_like on every string field independently ----
// Every field whose declared type includes `string` (userId, role, siteId,
// cameraId, reason) must be checked on its own -- dropping any one of them
// from the OR-chain must fail at least one of these.

const secretFieldCases = [
  { field: "userId", make: (value) => entry({ userId: value }) },
  { field: "role", make: (value) => entry({ role: value }) },
  { field: "siteId", make: (value) => entry({ siteId: value }) },
  { field: "cameraId", make: (value) => entry({ cameraId: value }) },
  { field: "reason", make: (value) => entry({ reason: value }) },
];

const secretPatternCases = [
  { label: "an rtsp URL", value: "rtsp://192.168.1.10/stream1" },
  { label: "a password= fragment", value: "retry with password=abc123xyz" },
  { label: "a user:pass@host URL", value: "http://admin:hunter2@10.0.0.5/api" },
  { label: "a 40+ char base64-ish run", value: `token=${"A".repeat(40)}` },
];

for (const { field, make } of secretFieldCases) {
  for (const { label, value } of secretPatternCases) {
    check(`checkAccessEntry: ${label} in ${field} gives secret_like`, () => {
      same(checkAccessEntry(make(value)), ["secret_like"]);
    });
  }
}

// ---- checkAccessEntry: the base64-ish alphabet includes '+' and '/' ----
// The regex's character class is [A-Za-z0-9+/], not [A-Za-z0-9] -- a run
// built only from '+' and '/' plus letters/digits must still count, and the
// 40-character threshold must be exact.

check("checkAccessEntry: a 40+ char run mixing '+' and '/' gives secret_like", () => {
  const run40 = "ab/cd+ef/gh+ij/kl+mn/op+qr/st+uv/wx+yz01"; // 40 chars, from [A-Za-z0-9+/]
  same(checkAccessEntry(entry({ reason: `token=${run40}` })), ["secret_like"]);
});

check("checkAccessEntry: the same '+'/'/' run one character short (39) is NOT secret_like on its own", () => {
  const run39 = "ab/cd+ef/gh+ij/kl+mn/op+qr/st+uv/wx+yz0"; // 39 chars
  same(checkAccessEntry(entry({ reason: `token=${run39}` })), []);
});

// ---- redactForInstaller: every video action redacts, without mutating the input ----
// Only "export" was ever exercised as a non-null-to-null redaction before --
// dropping any one of the four video actions from redactForInstaller's own
// list must fail this. Each case also proves the input entry is untouched
// (a deep-compare against a pre-call snapshot, not just an identity check)
// and that the result is a new object.

function checkVideoRedaction(action) {
  const original = entry({ action, cameraId: "cam-9" });
  const snapshotBefore = { ...original };

  const result = redactForInstaller(original, true);

  same(result, { ...snapshotBefore, cameraId: null }, `redacted result for ${action}`);
  if (result === original) {
    throw new Error(`redactForInstaller(${action}): expected a new object, got the same reference back`);
  }
  same(original, snapshotBefore, `input entry mutated by redactForInstaller for ${action}`);
}

check("redactForInstaller: blocked redacts cameraId for each video action, without mutating the input", () => {
  checkVideoRedaction("live_view");
  checkVideoRedaction("playback");
  checkVideoRedaction("export");
  checkVideoRedaction("snapshot");
});

// ---- redactForInstaller: a blocked non-video action is a new, unmutated object too ----
// The existing non-video test starts from an already-null cameraId, which
// cannot distinguish "left alone" from "never touched". This uses a
// non-null cameraId and checks both the returned value and that the input
// was not mutated in place.

check("redactForInstaller: blocked+non-video returns a new, unmutated object with cameraId untouched", () => {
  const original = entry({ action: "settings_change", transport: null, cameraId: "cam-9" });
  const snapshotBefore = { ...original };

  const result = redactForInstaller(original, true);

  same(result, snapshotBefore, "result for a blocked non-video action");
  if (result === original) {
    throw new Error("redactForInstaller(settings_change): expected a new object, got the same reference back");
  }
  same(original, snapshotBefore, "input entry mutated by redactForInstaller");
});

report("accessLog");
