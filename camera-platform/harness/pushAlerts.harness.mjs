// harness/pushAlerts.harness.mjs — contracts/pushAlerts.ts (MANAGER-ALERTS-
// SPEC.md, build 2: phone alerts). Pure logic only: no filesystem, no
// network, no clock of the module's own.
//
// FEARED: an account that lost rules.manage/events.view (or was removed —
// role: null) still receiving a push; a payload silently cut mid-character
// instead of refused whole; a status this codebase does not name (400, 413,
// a bare 200) being treated as "gone" or retried forever; the Review link
// this file builds by hand ever drifting from what URLSearchParams would
// have produced for the same firing.

import { Buffer } from "node:buffer";
import {
  mayReceiveFiring,
  buildPushPayload,
  reviewLinkFor,
  decideDelivery,
  RETRY_SCHEDULE_MS,
  MAX_LABEL_LENGTH,
  checkPushSubscriptionRow,
  upsertByEndpoint,
  subscriptionsForAccount,
  removeOwnSubscription,
  subscriptionCountsByAccount,
} from "../dist/pushAlerts.js";
import { check, eq, same, throws, report } from "./_assert.mjs";

console.log("push alerts");

// ---------------------------------------------------------------- who receives a firing

check("installer and manager, selection all: receives any rule", () => {
  eq(mayReceiveFiring({ role: "installer" }, "all", "r1"), true);
  eq(mayReceiveFiring({ role: "manager" }, "all", "r1"), true);
});

check("store: has events.view, so also receives (rules.manage is not the only qualifying permission)", () => {
  eq(mayReceiveFiring({ role: "store" }, "all", "r1"), true);
});

check("role: null (account gone, or never a user) never receives, whatever the selection", () => {
  eq(mayReceiveFiring({ role: null }, "all", "r1"), false);
  eq(mayReceiveFiring({ role: null }, ["r1"], "r1"), false);
});

check("a specific-rules selection only matches its own rule ids", () => {
  eq(mayReceiveFiring({ role: "manager" }, ["r1", "r2"], "r1"), true);
  eq(mayReceiveFiring({ role: "manager" }, ["r1", "r2"], "r3"), false);
  eq(mayReceiveFiring({ role: "manager" }, [], "r1"), false, "an empty selection matches nothing");
});

// ---------------------------------------------------------------- the payload

function firing(over = {}) {
  return {
    ruleName: "Manager's desk unattended",
    cameraId: "cam-1",
    startMs: Date.parse("2026-09-26T14:10:00.000Z"),
    endMs: Date.parse("2026-09-26T14:55:00.000Z"),
    text: "Manager's desk unattended 2:10-2:55 (45 min)",
    ...over,
  };
}

check("a normal firing builds title/body/url/at, url is the Review deep link keyed to startMs", () => {
  const f = firing();
  const r = buildPushPayload(f, 4078);
  eq(r.ok, true);
  eq(r.payload.title, f.ruleName);
  eq(r.payload.body, f.text);
  eq(r.payload.url, "/review?camera=cam-1&at=2026-09-26T14%3A10%3A00.000Z", "keyed to startMs, not endMs");
  eq(r.payload.at, new Date(f.endMs).toISOString(), "at uses endMs when the firing is complete");
});

check("an incomplete firing (endMs null) falls back to startMs for `at`, never guessing a return", () => {
  const f = firing({ endMs: null });
  const r = buildPushPayload(f, 4078);
  eq(r.ok, true);
  eq(r.payload.at, new Date(f.startMs).toISOString());
});

check("REQUIRED: a payload over budget is refused whole, never truncated", () => {
  const f = firing({ text: "x".repeat(500) });
  const full = JSON.stringify({ title: f.ruleName, body: f.text, url: reviewLinkFor(f.cameraId, f.startMs), at: new Date(f.endMs).toISOString() });
  const tooSmall = Buffer.byteLength(full, "utf8") - 1;
  const r = buildPushPayload(f, tooSmall);
  eq(r.ok, false);
  eq(typeof r.reason, "string");
  eq(r.reason.toLowerCase().includes("refused"), true);
  eq(Object.prototype.hasOwnProperty.call(r, "payload"), false, "no partial payload on a refusal");
});

check("REQUIRED: budget exactly at the byte count still succeeds (never off-by-one refusing a payload that fits)", () => {
  const f = firing();
  const exact = JSON.stringify({ title: f.ruleName, body: f.text, url: reviewLinkFor(f.cameraId, f.startMs), at: new Date(f.endMs).toISOString() });
  const bytes = Buffer.byteLength(exact, "utf8");
  eq(buildPushPayload(f, bytes).ok, true);
  eq(buildPushPayload(f, bytes - 1).ok, false);
});

check("REQUIRED: byte counting matches Buffer.byteLength(utf8) exactly, including multi-byte and astral (surrogate-pair) characters", () => {
  const f = firing({ text: "café éè 中文 😀 done" }); // accents, CJK, an emoji (surrogate pair)
  const r = buildPushPayload(f, 100_000);
  eq(r.ok, true);
  const expectedBytes = Buffer.byteLength(JSON.stringify(r.payload), "utf8");
  eq(r.bytes, expectedBytes, "the contract's own utf8ByteLength must match Node's Buffer.byteLength exactly");
});

check("buildPushPayload refuses a non-positive or non-integer budget rather than guess one", () => {
  throws(() => buildPushPayload(firing(), 0));
  throws(() => buildPushPayload(firing(), -1));
  throws(() => buildPushPayload(firing(), 1.5));
  throws(() => buildPushPayload(firing(), NaN));
});

check("REQUIRED: reviewLinkFor matches URLSearchParams' own encoding byte-for-byte for realistic camera ids and ISO timestamps", () => {
  const cases = [
    ["cam-1", Date.parse("2026-09-26T14:10:00.000Z")],
    ["cam_7", Date.parse("2026-01-01T00:00:00.000Z")],
    ["cam-99", Date.parse("2026-11-01T06:59:59.999Z")], // a DST-adjacent instant
  ];
  for (const [cameraId, ms] of cases) {
    const mine = reviewLinkFor(cameraId, ms);
    const q = new URLSearchParams({ camera: cameraId, at: new Date(ms).toISOString() });
    eq(mine, "/review?" + q.toString(), `parity for ${cameraId} @ ${ms}`);
  }
});

// ---------------------------------------------------------------- retry schedule / the gone rule

check("RETRY_SCHEDULE_MS is exactly 1 min, 5 min, 30 min", () => {
  same(RETRY_SCHEDULE_MS, [60_000, 300_000, 1_800_000]);
});

check("201/202 is sent", () => {
  eq(decideDelivery(201, 0).kind, "sent");
  eq(decideDelivery(202, 0).kind, "sent");
});

check("REQUIRED: 404 and 410 are gone (delete), at any attempt count", () => {
  eq(decideDelivery(404, 0).kind, "delete");
  eq(decideDelivery(410, 2).kind, "delete");
});

check("REQUIRED: 429 and 5xx follow the retry schedule, then fail", () => {
  for (const status of [429, 500, 502, 503, 599]) {
    let d = decideDelivery(status, 0);
    same(d, { kind: "retry", delayMs: 60_000, attempt: 1 }, `${status} attempt 0`);
    d = decideDelivery(status, d.attempt);
    same(d, { kind: "retry", delayMs: 300_000, attempt: 2 }, `${status} attempt 1`);
    d = decideDelivery(status, d.attempt);
    same(d, { kind: "retry", delayMs: 1_800_000, attempt: 3 }, `${status} attempt 2`);
    d = decideDelivery(status, d.attempt);
    same(d, { kind: "failed" }, `${status} attempt 3: retries exhausted`);
  }
});

check("REQUIRED: every other status (400, 413 too-large, 304, a bare 200) fails at once — never retried, never deleted", () => {
  for (const status of [400, 413, 304, 200, 301]) {
    eq(decideDelivery(status, 0).kind, "failed", `status ${status}`);
    eq(decideDelivery(status, 5).kind, "failed", `status ${status}, later attempt too`);
  }
});

check("decideDelivery refuses a non-integer status, and a bad attempt count only when it would matter (a retryable status)", () => {
  throws(() => decideDelivery(1.5, 0));
  throws(() => decideDelivery(NaN, 0));
  throws(() => decideDelivery(429, -1));
  throws(() => decideDelivery(429, 1.5));
  // a non-retryable status never even looks at `attempt`, so a bad one there is harmless
  eq(decideDelivery(404, -1).kind, "delete");
});

// ---------------------------------------------------------------- push-subscriptions.json row shape

function rawRow(over = {}) {
  return {
    id: "sub-1",
    username: "manager1",
    endpoint: "https://push.example.com/abc",
    p256dh: "BASE64URL_P256DH",
    auth: "BASE64URL_AUTH",
    createdUtc: "2026-09-26T00:00:00.000Z",
    label: "iPhone Safari",
    rules: "all",
    ...over,
  };
}

check("a well-formed row checks ok, with label trimmed and rules carried through", () => {
  const r = checkPushSubscriptionRow(rawRow({ label: "  iPhone Safari  " }));
  eq(r.ok, true);
  eq(r.row.label, "iPhone Safari");
  eq(r.row.rules, "all");
});

check("label omitted or blank becomes null, never an empty string", () => {
  eq(checkPushSubscriptionRow(rawRow({ label: undefined })).row.label, null);
  eq(checkPushSubscriptionRow(rawRow({ label: null })).row.label, null);
  eq(checkPushSubscriptionRow(rawRow({ label: "   " })).row.label, null);
});

check("a rule-id array is deduplicated, order preserved", () => {
  const r = checkPushSubscriptionRow(rawRow({ rules: ["r1", "r2", "r1"] }));
  eq(r.ok, true);
  same(r.row.rules, ["r1", "r2"]);
});

check("REQUIRED: every missing/bad field is reported at once, not the first alone", () => {
  const r = checkPushSubscriptionRow({ label: "x".repeat(200), rules: 5 });
  eq(r.ok, false);
  const fields = r.errors.map((e) => e.field).sort();
  eq(fields.includes("id"), true);
  eq(fields.includes("username"), true);
  eq(fields.includes("endpoint"), true);
  eq(fields.includes("p256dh"), true);
  eq(fields.includes("auth"), true);
  eq(fields.includes("createdUtc"), true);
  eq(fields.includes("label"), true);
  eq(fields.includes("rules"), true);
  eq(r.errors.length >= 8, true);
});

check("an empty rule-id array is refused (bad_rule_selection), never silently treated as \"all\" or \"none\"", () => {
  const r = checkPushSubscriptionRow(rawRow({ rules: [] }));
  eq(r.ok, false);
  eq(r.errors.some((e) => e.field === "rules"), true);
});

check("a row that is not an object is refused cleanly", () => {
  eq(checkPushSubscriptionRow(null).ok, false);
  eq(checkPushSubscriptionRow("nope").ok, false);
  eq(checkPushSubscriptionRow([1, 2]).ok, false);
});

check("MAX_LABEL_LENGTH is 60, and a label right at the limit is accepted, one over is refused", () => {
  eq(MAX_LABEL_LENGTH, 60);
  eq(checkPushSubscriptionRow(rawRow({ label: "x".repeat(60) })).ok, true);
  eq(checkPushSubscriptionRow(rawRow({ label: "x".repeat(61) })).ok, false);
});

// ---------------------------------------------------------------- list transforms

const rowFor = (username, endpoint, id = endpoint) => ({ ...rawRow({ username, endpoint, id }) });

check("REQUIRED: upsertByEndpoint replaces an existing row for the SAME endpoint, never duplicates it", () => {
  const rows = [rowFor("a", "https://e/1"), rowFor("b", "https://e/2")];
  const replacement = rowFor("c", "https://e/1", "new-id");
  const next = upsertByEndpoint(rows, replacement);
  eq(next.length, 2, "still two rows, not three");
  eq(next.some((r) => r.endpoint === "https://e/1" && r.username === "c"), true, "the new row for that endpoint is present");
  eq(next.some((r) => r.username === "a"), false, "the OLD row for that endpoint is gone");
  eq(next.some((r) => r.username === "b" && r.endpoint === "https://e/2"), true, "an unrelated row is untouched");
});

check("upsertByEndpoint on a brand-new endpoint appends rather than replacing anything", () => {
  const rows = [rowFor("a", "https://e/1")];
  const next = upsertByEndpoint(rows, rowFor("a", "https://e/2"));
  eq(next.length, 2);
});

check("REQUIRED: subscriptionsForAccount returns only that account's own rows, others never leak in", () => {
  const rows = [rowFor("a", "https://e/1"), rowFor("b", "https://e/2"), rowFor("a", "https://e/3")];
  const mine = subscriptionsForAccount(rows, "a");
  eq(mine.length, 2);
  eq(mine.every((r) => r.username === "a"), true);
});

check("REQUIRED: removeOwnSubscription only removes the row matching BOTH username and id — never someone else's row by id collision", () => {
  const rows = [rowFor("a", "https://e/1", "same-id"), rowFor("b", "https://e/2", "same-id")];
  const next = removeOwnSubscription(rows, "a", "same-id");
  eq(next.length, 1, "only account a's row is removed");
  eq(next[0].username, "b", "account b's row, with the SAME id, is untouched");
});

check("removeOwnSubscription is a no-op (same rows, not the same array instance) when nothing matches", () => {
  const rows = [rowFor("a", "https://e/1")];
  const next = removeOwnSubscription(rows, "a", "does-not-exist");
  eq(next.length, 1);
  eq(next === rows, false, "a fresh array is always returned, never the input mutated in place");
});

check("REQUIRED: subscriptionCountsByAccount never carries an endpoint, id, or key material — counts only", () => {
  const rows = [rowFor("a", "https://e/1"), rowFor("a", "https://e/2"), rowFor("b", "https://e/3")];
  const counts = subscriptionCountsByAccount(rows);
  same(counts, { a: 2, b: 1 });
  const text = JSON.stringify(counts);
  eq(text.includes("https://"), false, "no endpoint anywhere in the counts");
  eq(text.includes("BASE64URL"), false, "no key material anywhere in the counts");
});

check("subscriptionCountsByAccount of no rows is an empty object", () => {
  same(subscriptionCountsByAccount([]), {});
});

report("push alerts");
