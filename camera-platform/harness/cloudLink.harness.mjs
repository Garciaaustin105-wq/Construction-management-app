// harness/cloudLink.harness.mjs — contracts/cloudLink.ts (CLOUD-LINK-SPEC.md
// section A)
//
// NOT REGISTERED in harness/run-all.mjs (new harnesses never are — see
// AGENTS.md); run it directly: `node harness/cloudLink.harness.mjs`.
//
// Covers exactly CLOUD-LINK-SPEC.md section E's "contract" bullet: every
// refusal reason; http refused; credentials in the URL refused; the four
// states; an expired code is flagged, not silently shown or dropped;
// never-checked-in is null; the two URL helpers never produce "//". The
// API/timer/units/page bullets belong to other files' own harnesses.
//
// FEARED: http accepted or silently upgraded instead of refused; a
// user:pass@ URL stored and later sent as this box's own cloud address; an
// expired claim code still shown as live, or the whole state vanishing
// instead of saying so; a check-in that never happened reading as some
// default time instead of null; enrollUrlOf/checkinUrlOf gluing a stored
// trailing slash into "//enroll"; a hand-rolled URL parser disagreeing with
// a real WHATWG parser about what counts as a valid https address or where
// its credentials are.

import { check, eq, same, throws, report } from "./_assert.mjs";
import {
  DEFAULT_CLOUD_SETTINGS,
  checkCloudSettings,
  enrollUrlOf,
  checkinUrlOf,
  cloudStatusView,
} from "../dist/cloudLink.js";

console.log("cloud link");

// ---------------------------------------------------------------- DEFAULT_CLOUD_SETTINGS

check("DEFAULT_CLOUD_SETTINGS is off, with no address", () => {
  same(DEFAULT_CLOUD_SETTINGS, { url: null, enabled: false });
});

// ---------------------------------------------------------------- checkCloudSettings: not_an_object

check("REQUIRED: every non-object payload is refused as not_an_object", () => {
  for (const bad of [null, undefined, [], "https://cloud.example.com", 1, true]) {
    const r = checkCloudSettings(bad);
    eq(r.ok, false, JSON.stringify(bad));
    eq(r.reason, "not_an_object", JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- checkCloudSettings: the happy paths

check("the default payload (url null, enabled false) is valid", () => {
  const r = checkCloudSettings({ url: null, enabled: false });
  eq(r.ok, true);
  same(r.settings, { url: null, enabled: false });
});

check("a real https address with enabled true is accepted and stored verbatim", () => {
  const r = checkCloudSettings({ url: "https://cloud.example.com", enabled: true });
  eq(r.ok, true);
  same(r.settings, { url: "https://cloud.example.com", enabled: true });
});

check("a bare https address with enabled false is accepted (configured, not yet turned on)", () => {
  const r = checkCloudSettings({ url: "https://cloud.example.com", enabled: false });
  eq(r.ok, true);
  same(r.settings, { url: "https://cloud.example.com", enabled: false });
});

check("an upper-case scheme is accepted like a real URL parser accepts it (case-insensitive)", () => {
  const r = checkCloudSettings({ url: "HTTPS://cloud.example.com", enabled: false });
  eq(r.ok, true);
  eq(r.settings.url, "HTTPS://cloud.example.com", "only the scheme's CASE-insensitivity is honoured; the string itself is not re-cased");
});

check("a port and a path on the address are accepted", () => {
  const r = checkCloudSettings({ url: "https://cloud.example.com:8443/fleet", enabled: true });
  eq(r.ok, true);
  eq(r.settings.url, "https://cloud.example.com:8443/fleet");
});

check("an IPv6 literal address is accepted", () => {
  const r = checkCloudSettings({ url: "https://[2001:db8::1]:8443/fleet", enabled: false });
  eq(r.ok, true);
  eq(r.settings.url, "https://[2001:db8::1]:8443/fleet");
});

check("WHATWG fidelity: https is a special scheme, so authority parsing runs even without a literal '//', and extra leading slashes are skipped — checked against a real `new URL()`, which resolves all three of these to host \"cloud\"", () => {
  for (const raw of ["https:cloud/x", "https:///cloud/x", "https:" + "\\\\" + "cloud/x"]) {
    const r = checkCloudSettings({ url: raw, enabled: false });
    eq(r.ok, true, raw);
  }
});

check("a stray trailing newline pasted with the address is cleaned off before it is stored", () => {
  const r = checkCloudSettings({ url: "https://cloud.example.com/fleet\n", enabled: false });
  eq(r.ok, true);
  eq(r.settings.url, "https://cloud.example.com/fleet", "the WHATWG preprocessing trim, not a fresh trim() of our own");
});

check("leading/trailing whitespace on a pasted address is cleaned off the same way", () => {
  const r = checkCloudSettings({ url: "  https://cloud.example.com  ", enabled: false });
  eq(r.ok, true);
  eq(r.settings.url, "https://cloud.example.com");
});

// ---------------------------------------------------------------- checkCloudSettings: REQUIRED — every refusal reason, http refused

check("REQUIRED: http:// is refused as bad_url, never silently upgraded to https", () => {
  const r = checkCloudSettings({ url: "http://cloud.example.com", enabled: false });
  eq(r.ok, false);
  eq(r.reason, "bad_url");
});

check("REQUIRED: a non-string url (present, wrong type) is bad_url", () => {
  for (const bad of [1, true, [], {}, undefined]) {
    const r = checkCloudSettings({ url: bad, enabled: false });
    eq(r.ok, false, JSON.stringify(bad));
    eq(r.reason, "bad_url", JSON.stringify(bad));
  }
});

check("REQUIRED: an unparseable or non-https string is bad_url", () => {
  for (const bad of [
    "",
    "not a url",
    "cloud.example.com",          // no scheme at all
    "ftp://cloud.example.com",    // a real, parseable URL — just the wrong scheme
    "wss://cloud.example.com",
    "https://",                   // scheme with no host at all
    "https://user@",              // host empty once credentials are stripped
    "https://:8443",              // a port with no host
    "https://exa mple.com",       // an embedded space — not a valid host
    "https://exa\u0000mple.com",  // an embedded NUL
    "https://a:b:80",             // a second colon makes the "port" not all digits
    "https://[::1",               // an unmatched IPv6 bracket
    "https://[]:8443",            // an empty bracket pair
  ]) {
    const r = checkCloudSettings({ url: bad, enabled: false });
    eq(r.ok, false, JSON.stringify(bad));
    eq(r.reason, "bad_url", JSON.stringify(bad));
  }
});

check("REQUIRED: credentials in the URL (user:pass@) are refused, distinctly from a merely bad URL", () => {
  for (const bad of [
    "https://user:pass@cloud.example.com",
    "https://user@cloud.example.com",
    "https://:pass@cloud.example.com",
    "https://@cloud.example.com", // a bare '@' with nothing meaningful either side still counts (build rule 10)
  ]) {
    const r = checkCloudSettings({ url: bad, enabled: false });
    eq(r.ok, false, bad);
    eq(r.reason, "url_has_credentials", bad);
  }
});

check("REQUIRED: a non-boolean or missing enabled is bad_enabled", () => {
  for (const raw of [
    { url: null },
    { url: null, enabled: undefined },
    { url: null, enabled: "true" },
    { url: null, enabled: 1 },
    { url: null, enabled: null },
  ]) {
    const r = checkCloudSettings(raw);
    eq(r.ok, false, JSON.stringify(raw));
    eq(r.reason, "bad_enabled", JSON.stringify(raw));
  }
});

check("REQUIRED: enabled true with url null is bad_url — nothing to enable", () => {
  const r = checkCloudSettings({ url: null, enabled: true });
  eq(r.ok, false);
  eq(r.reason, "bad_url");
});

check("an absent url key is treated the same as a wrong type, not silently as null", () => {
  const r = checkCloudSettings({ enabled: false });
  eq(r.ok, false);
  eq(r.reason, "bad_url");
});

// ---------------------------------------------------------------- the two URL helpers: never a double slash

check("REQUIRED: enrollUrlOf/checkinUrlOf never produce '//' at the join, however many trailing slashes the stored address has", () => {
  const cases = [
    ["https://cloud.example.com", "https://cloud.example.com/enroll"],
    ["https://cloud.example.com/", "https://cloud.example.com/enroll"],
    ["https://cloud.example.com//", "https://cloud.example.com/enroll"],
    ["https://cloud.example.com///", "https://cloud.example.com/enroll"],
    ["https://cloud.example.com/fleet", "https://cloud.example.com/fleet/enroll"],
    ["https://cloud.example.com/fleet/", "https://cloud.example.com/fleet/enroll"],
  ];
  for (const [base, expected] of cases) {
    eq(enrollUrlOf(base), expected, base);
    eq(enrollUrlOf(base).includes("//enroll"), false, base);
  }
});

check("checkinUrlOf joins the same way, at /checkin", () => {
  eq(checkinUrlOf("https://cloud.example.com"), "https://cloud.example.com/checkin");
  eq(checkinUrlOf("https://cloud.example.com/"), "https://cloud.example.com/checkin");
  eq(checkinUrlOf("https://cloud.example.com//"), "https://cloud.example.com/checkin");
  eq(checkinUrlOf("https://cloud.example.com//").includes("//checkin"), false);
});

check("enrollUrlOf and checkinUrlOf never collide with each other's suffix", () => {
  const base = "https://cloud.example.com/fleet/";
  eq(enrollUrlOf(base), "https://cloud.example.com/fleet/enroll");
  eq(checkinUrlOf(base), "https://cloud.example.com/fleet/checkin");
});

// ---------------------------------------------------------------- cloudStatusView: REQUIRED — the four states

const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function enrollment(overrides = {}) {
  return {
    url: "https://cloud.example.com",
    deviceId: "dev-abc123",
    claimed: false,
    claimCode: "ABCD-EFGH-3",
    expiresUtc: "2026-09-28T13:00:00.000Z", // one hour after NOW
    atUtc: "2026-09-28T11:00:00.000Z",
    ...overrides,
  };
}

check("REQUIRED: off — enabled is false, whatever the enrollment says", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: false },
    enrollment: enrollment(),
    checkin: null,
    nowMs: NOW,
  });
  eq(view.state, "off");
});

check("REQUIRED: not_enrolled — enabled true, never enrolled", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: null,
    checkin: null,
    nowMs: NOW,
  });
  eq(view.state, "not_enrolled");
  eq(view.deviceId, null);
  eq(view.claimCode, null);
});

check("REQUIRED: waiting_for_claim — enrolled, a code, not yet claimed", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: enrollment(),
    checkin: null,
    nowMs: NOW,
  });
  eq(view.state, "waiting_for_claim");
  eq(view.deviceId, "dev-abc123");
  eq(view.claimCode, "ABCD-EFGH-3");
  eq(view.codeExpiresUtc, "2026-09-28T13:00:00.000Z");
  eq(view.codeExpired, false);
});

check("REQUIRED: claimed — enrolled and claimed, no code to show", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: enrollment({ claimed: true, claimCode: null, expiresUtc: null }),
    checkin: null,
    nowMs: NOW,
  });
  eq(view.state, "claimed");
  eq(view.deviceId, "dev-abc123");
  eq(view.claimCode, null);
  eq(view.codeExpiresUtc, null);
  eq(view.codeExpired, false);
});

// ---------------------------------------------------------------- REQUIRED: an expired code is flagged, not hidden or dropped

check("REQUIRED: a code past its expiresUtc is flagged (codeExpired true) and hidden (claimCode null), but the state and codeExpiresUtc are not silently dropped", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: enrollment({ expiresUtc: "2026-09-28T11:00:00.000Z" }), // one hour BEFORE NOW
    checkin: null,
    nowMs: NOW,
  });
  eq(view.state, "waiting_for_claim", "still enrolled and unclaimed — the state itself does not vanish");
  eq(view.codeExpired, true);
  eq(view.claimCode, null, "the code itself is hidden once expired");
  eq(view.codeExpiresUtc, "2026-09-28T11:00:00.000Z", "WHEN it expired is still reported, never dropped");
});

check("the expiry boundary is inclusive: exactly at expiresUtc counts as expired, one ms before does not", () => {
  const atExpiry = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: enrollment({ expiresUtc: new Date(NOW).toISOString() }),
    checkin: null,
    nowMs: NOW,
  });
  eq(atExpiry.codeExpired, true);
  const beforeExpiry = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: enrollment({ expiresUtc: new Date(NOW + 1).toISOString() }),
    checkin: null,
    nowMs: NOW,
  });
  eq(beforeExpiry.codeExpired, false);
});

check("claimCode is hidden outside waiting_for_claim even when the underlying code has not expired — e.g. cloud switched back off", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: false }, // off
    enrollment: enrollment(), // claimed: false, a fresh, un-expired code
    checkin: null,
    nowMs: NOW,
  });
  eq(view.state, "off");
  eq(view.claimCode, null, "off means off, even with a live code sitting in cloud-enrollment.json");
  eq(view.deviceId, "dev-abc123", "measurements are still reported (build rule 11), only claimCode is state-gated");
});

check("codeExpired is false, not left undefined, whenever there is no code in play at all", () => {
  for (const settings of [{ url: "https://cloud.example.com", enabled: false }, { url: "https://cloud.example.com", enabled: true }]) {
    const view = cloudStatusView({ settings, enrollment: settings.enabled ? enrollment({ claimed: true, claimCode: null, expiresUtc: null }) : null, checkin: null, nowMs: NOW });
    eq(view.codeExpired, false, JSON.stringify(settings));
  }
});

// ---------------------------------------------------------------- REQUIRED: never-checked-in is null

check("REQUIRED: a null checkin reads as lastCheckinUtc null and lastOutcome null — never a guessed time", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: null,
    checkin: null,
    nowMs: NOW,
  });
  eq(view.lastCheckinUtc, null);
  eq(view.lastOutcome, null);
});

check("a real checkin record is echoed exactly", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: true },
    enrollment: null,
    checkin: { seq: 42, lastOutcome: "sent", lastAtUtc: "2026-09-28T11:59:00.000Z" },
    nowMs: NOW,
  });
  eq(view.lastCheckinUtc, "2026-09-28T11:59:00.000Z");
  eq(view.lastOutcome, "sent");
});

check("a checkin record survives even in the off state — a historical fact, not a verdict", () => {
  const view = cloudStatusView({
    settings: { url: "https://cloud.example.com", enabled: false },
    enrollment: null,
    checkin: { seq: 3, lastOutcome: "rejected", lastAtUtc: "2026-09-27T00:00:00.000Z" },
    nowMs: NOW,
  });
  eq(view.state, "off");
  eq(view.lastCheckinUtc, "2026-09-27T00:00:00.000Z");
  eq(view.lastOutcome, "rejected");
});

// ---------------------------------------------------------------- cloudStatusView: caller-bug guard

check("cloudStatusView throws on a caller bug (a non-finite nowMs), rather than silently accepting garbage", () => {
  const args = { settings: { url: null, enabled: false }, enrollment: null, checkin: null };
  throws(() => cloudStatusView({ ...args, nowMs: NaN }), "NaN");
  throws(() => cloudStatusView({ ...args, nowMs: undefined }), "undefined");
  throws(() => cloudStatusView({ ...args, nowMs: "2026-09-28" }), "a string");
});

// ---- Added 2026-09-28 from the review: the hand-written parser accepted
// out-of-range ports and control characters in the host, both of which a
// real WHATWG URL parser refuses -- a typo or a pasted hidden character could
// be saved as a "valid" cloud address.

check("a port above 65535 is bad_url; 65535 and an empty port are fine", () => {
  for (const port of ["65536", "70000", "99999999999"]) {
    same(checkCloudSettings({ url: `https://cloud.example.test:${port}/`, enabled: true }), { ok: false, reason: "bad_url" }, port);
  }
  eq(checkCloudSettings({ url: "https://cloud.example.test:65535/", enabled: true }).ok, true, "65535");
  eq(checkCloudSettings({ url: "https://cloud.example.test:443/", enabled: true }).ok, true, "443");
});

check("a control character inside the host is bad_url (C0, DEL and C1)", () => {
  for (const c of ["\u0000", "\u0001", "\u0007", "\u001b", "\u007f", "\u0085", "\u009f"]) {
    same(checkCloudSettings({ url: `https://clo${c}ud.example.test/`, enabled: true }), { ok: false, reason: "bad_url" }, JSON.stringify(c));
  }
});

check("agrees with the real WHATWG URL parser on accept/refuse for tricky addresses", () => {
  const cases = [
    "https://cloud.example.test/", "https://cloud.example.test:8443/api", "https://127.0.0.1:8443", "https://[::1]:8443/",
    "https://cloud.example.test:65536/", "https://clo\u001bud.example.test/", "https://clo\u0085ud.example.test/",
    "https://a:b:80/x", "https://:8443/", "https:///nohost", "http://cloud.example.test/", "https://user:pw@cloud.example.test/",
    "HTTPS://CLOUD.EXAMPLE.TEST/", "https://cloud.example.test:/",
  ];
  for (const url of cases) {
    let real = false;
    try { const u = new URL(url); real = u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname !== ""; } catch { real = false; }
    eq(checkCloudSettings({ url, enabled: true }).ok, real, JSON.stringify(url));
  }
});

report("cloud link");
