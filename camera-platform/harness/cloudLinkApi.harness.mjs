/**
 * GET/POST /cloud-link and POST /cloud-link/enroll, end to end through the
 * real server (agent/api-server.mjs -> agent/cloud-link.mjs ->
 * dist/cloudLink.js, and, for the enrol route, agent/cloud-enroll.mjs's own
 * enroll()). CLOUD-LINK-SPEC.md section E's own "Tests that matter", "API"
 * bullet: 403 for a store or manager account; a bad body is 400 with the
 * reason and changes nothing on disk; changing the URL clears the old
 * enrolment and says so; enrol while off is 409; no response ever contains
 * key material.
 *
 * NOT REGISTERED in harness/run-all.mjs (new harnesses never are); run it
 * directly: `node harness/cloudLinkApi.harness.mjs`.
 *
 * This harness never touches the real network or a real device identity:
 * POST /cloud-link/enroll is proven against a fake fetch and a fake
 * identity, injected through createApiServer's own cloudLinkFetchFn /
 * cloudLinkIdentity (the same shape pushFetchFn already gives
 * harness/pushAlerts.harness.mjs for manager alerts) -- never the real
 * globalThis.fetch or agent/device-identity.mjs.
 *
 * THE FEARED FAILURES, by name:
 * - a store OR a manager account reaching /cloud-link at all (installer
 *   only, exactly like /site-settings);
 * - a rejected POST /cloud-link body reaching cloud.json anyway;
 * - a URL change that leaves the OLD cloud's claim code or device id
 *   sitting on disk looking current, or clears it silently without saying
 *   so in the response;
 * - enrolling while the switch is off actually calling out to the network;
 * - any response (GET, POST, or the enrol route, success or failure)
 *   carrying a device's public key PEM, a signature, or anything else that
 *   was never meant to leave the box.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { CLOUD_ENROLLMENT_FILE } from "../agent/cloud-enroll.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("cloud link API");

const audits = [];
const authAs = (principal) => ({
  principalOf: () => principal,
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
});
const installer = authAs({ kind: "user", username: "tech", role: "installer" });

const stateDir = await mkdtemp(join(tmpdir(), "camplat-cloudlink-"));
const config = {
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: "svc-pw" },
  cameras: [],
};
await writeFile(join(stateDir, "config.json"), JSON.stringify(config));

/** A real Ed25519 identity, generated here and never written to disk --
 *  mirrors harness/cloudEnroll.harness.mjs's own fakeIdentity(). */
function fakeIdentity(deviceId = "device-test-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    deviceId,
    publicKeyPem,
    loadOrCreateIdentity: async () => ({ deviceId, publicKeyPem, createdAtUtc: "2026-09-01T00:00:00.000Z" }),
    signWithIdentity: async (_stateDir, message) => cryptoSign(null, message, privateKey),
  };
}

/** `body === null` gives an empty response body (the "no body at all"
 *  case), matching harness/cloudEnroll.harness.mjs's own fakeFetch(). */
function fakeFetch(status, body = null, { calls = [] } = {}) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { status, text: async () => (body === null ? "" : JSON.stringify(body)) };
  };
}

const index = openIndex(indexPathFor(stateDir));
const startServer = (auth, { fetchFn, identity } = {}) => createApiServer({
  stateDir, config, index, auth,
  ...(fetchFn !== undefined ? { cloudLinkFetchFn: fetchFn } : {}),
  ...(identity !== undefined ? { cloudLinkIdentity: identity } : {}),
});
let server = startServer(installer);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let base = `http://127.0.0.1:${server.address().port}`;

const noKeyMaterial = (text, what) => {
  for (const marker of ["PRIVATE", "BEGIN", "PUBLIC KEY", "signatureB64", "publicKeyPem"]) {
    if (text.includes(marker)) throw new Error(`${what} carries key material (${marker}): ${text}`);
  }
};
// EVERY response through this helper is checked for key material (spec
// section E: "no response ever contains key material") -- a review found
// the check had been called on only 2 of ~10 response bodies.
let responsesChecked = 0;
const send = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  noKeyMaterial(text, `${method} ${path} (status ${res.status})`);
  responsesChecked++;
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json };
};
const cloudFile = join(stateDir, "cloud.json");
const enrollFile = join(stateDir, CLOUD_ENROLLMENT_FILE);

try {
  await check("GET /cloud-link on a fresh box: off, never enrolled, never checked in", async () => {
    const r = await send("GET", "/cloud-link");
    eq(r.status, 200);
    noKeyMaterial(r.text, "GET /cloud-link");
    eq(r.json.ok, true);
    eq(r.json.settings, { url: null, enabled: false });
    eq(r.json.state, "off");
    eq(r.json.deviceId, null);
    eq(r.json.claimCode, null);
    eq(r.json.codeExpiresUtc, null);
    eq(r.json.codeExpired, false);
    eq(r.json.lastCheckinUtc, null, "a blank is not a zero: never checked in reads as null, not a guessed time");
    eq(r.json.lastOutcome, null);
    eq(r.json.problem, null, "a genuinely missing cloud.json is the defaults, not a reported problem");
  });

  await check("REQUIRED: a bad body is refused 400 with the reason, and changes nothing on disk", async () => {
    for (const bad of [
      { url: "http://cloud.example.com", enabled: true }, // http refused
      { url: "https://user:pass@cloud.example.com", enabled: false }, // credentials in the url
      { url: null, enabled: true }, // enabled true with no url
      { url: "not a url", enabled: false },
      { enabled: false }, // url missing entirely
      { url: null }, // enabled missing entirely
      "not even an object",
      null,
    ]) {
      const r = await send("POST", "/cloud-link", bad);
      eq(r.status, 400, JSON.stringify(bad));
      eq(typeof r.json.code, "string", JSON.stringify(bad));
      eq(r.json.ok, false, JSON.stringify(bad));
    }
    let onDisk = null;
    try { onDisk = await readFile(cloudFile, "utf8"); } catch { /* fine: never written at all yet */ }
    eq(onDisk, null, "not one of the bad bodies above ever created cloud.json");
  });

  await check("saving a real https address with enabled false is accepted (configured, not yet turned on)", async () => {
    const r = await send("POST", "/cloud-link", { url: "https://cloud.example.test", enabled: false });
    eq(r.status, 200);
    eq(r.json.ok, true);
    eq(r.json.settings, { url: "https://cloud.example.test", enabled: false });
    eq(r.json.enrollmentCleared, false, "nothing to clear: no enrolment existed yet");
    const view = await send("GET", "/cloud-link");
    eq(view.json.settings, r.json.settings, "GET reflects the save at once");
    eq(view.json.state, "off", "enabled is still false");
    const stored = JSON.parse(await readFile(cloudFile, "utf8"));
    eq(stored, { url: "https://cloud.example.test", enabled: false });
  });

  await check("REQUIRED: enrolling while off is refused 409 cloud_off, and nothing is sent", async () => {
    const calls = [];
    const s = startServer(installer, { fetchFn: fakeFetch(200, {}, { calls }), identity: fakeIdentity() });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      const r = await fetch(`${b}/cloud-link/enroll`, { method: "POST" });
      eq(r.status, 409);
      const json = await r.json();
      eq(json.ok, false);
      eq(json.code, "cloud_off");
      eq(calls.length, 0, "FEARED: enrol() must never be reached while the switch is off");
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  await check("turning the cloud on, then enrolling: a real signed envelope goes out, and the fresh status view comes back", async () => {
    await send("POST", "/cloud-link", { url: "https://cloud.example.test", enabled: true });

    const calls = [];
    const id = fakeIdentity("device-abc");
    const responseBody = { ok: true, claimed: false, claimCode: "ABCD-EFGH-A", expiresUtc: "2099-01-01T00:00:00.000Z" };
    const s = startServer(installer, { fetchFn: fakeFetch(200, responseBody, { calls }), identity: id });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      const r = await fetch(`${b}/cloud-link/enroll`, { method: "POST" });
      const text = await r.text();
      eq(r.status, 200);
      noKeyMaterial(text, "POST /cloud-link/enroll (success)");
      const json = JSON.parse(text);
      eq(json.ok, true);
      eq(json.settings, { url: "https://cloud.example.test", enabled: true });
      eq(json.state, "waiting_for_claim");
      eq(json.deviceId, "device-abc");
      eq(json.claimCode, "ABCD-EFGH-A");
      eq(json.codeExpired, false);

      eq(calls.length, 1, "exactly one POST to the cloud");
      eq(calls[0].url, "https://cloud.example.test/enroll", "enrollUrlOf joined the stored address");

      const saved = JSON.parse(await readFile(enrollFile, "utf8"));
      eq(saved.deviceId, "device-abc");
      eq(saved.claimCode, "ABCD-EFGH-A");

      const view = await fetch(`${b}/cloud-link`).then((res) => res.json());
      eq(view.state, "waiting_for_claim", "GET reflects the enrolment at once");
      eq(view.claimCode, "ABCD-EFGH-A");
    } finally {
      await new Promise((r) => s.close(r));
    }

    const enrollAudits = audits.filter((a) => a.event === "cloud.enroll");
    eq(enrollAudits.length >= 1, true, "the enrol attempt was audited");
    eq(enrollAudits.every((a) => a.actor === "tech"), true);
    eq(JSON.stringify(audits).includes("ABCD-EFGH-A"), false, "FEARED: the claim code must never appear in an audit line");
  });

  await check("REQUIRED: changing the URL clears the old enrolment, and the response says so", async () => {
    let stillThere = true;
    try { await readFile(enrollFile, "utf8"); } catch { stillThere = false; }
    eq(stillThere, true, "the prior check's own enrolment is on disk before this save");

    const r = await send("POST", "/cloud-link", { url: "https://cloud.example.test/other", enabled: true });
    eq(r.status, 200);
    eq(r.json.enrollmentCleared, true, "REQUIRED: the response states the clear, never silently");

    let afterExists = true;
    try { await readFile(enrollFile, "utf8"); } catch { afterExists = false; }
    eq(afterExists, false, "FEARED: the old cloud's enrolment must not survive a url change");

    const view = await send("GET", "/cloud-link");
    eq(view.json.state, "not_enrolled", "the new address has no enrolment of its own yet");
    eq(view.json.deviceId, null);
  });

  await check("saving with the SAME url (only enabled changes) never clears an enrolment", async () => {
    await send("POST", "/cloud-link", { url: "https://cloud.example.test/other", enabled: true });
    // enrol again against the current (post-change) address so there is an
    // enrolment on file to prove survives an enabled-only save.
    const s = startServer(installer, {
      fetchFn: fakeFetch(200, { ok: true, claimed: false, claimCode: "1234-5678-K", expiresUtc: "2099-01-01T00:00:00.000Z" }),
      identity: fakeIdentity("device-xyz"),
    });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    try {
      await fetch(`http://127.0.0.1:${s.address().port}/cloud-link/enroll`, { method: "POST" });
    } finally {
      await new Promise((r) => s.close(r));
    }
    const before = await readFile(enrollFile, "utf8");

    const r = await send("POST", "/cloud-link", { url: "https://cloud.example.test/other", enabled: false });
    eq(r.status, 200);
    eq(r.json.enrollmentCleared, false, "same url: nothing was cleared");
    const after = await readFile(enrollFile, "utf8");
    eq(after, before, "the enrolment file itself is untouched");
  });

  await check("FEARED: a corrupt hand-edited cloud.json refuses the next save instead of silently rebuilding it from empty", async () => {
    const before = await readFile(cloudFile, "utf8");
    await writeFile(cloudFile, "{ not valid json", "utf8");

    const r = await send("POST", "/cloud-link", { url: "https://cloud.example.test/other", enabled: true });
    eq(r.status, 409);
    eq(r.json.code, "cloud_settings_unreadable");

    const onDisk = await readFile(cloudFile, "utf8");
    eq(onDisk, "{ not valid json", "the file itself was never overwritten by the refused save");

    const view = await send("GET", "/cloud-link");
    eq(view.status, 200);
    eq(view.json.settings, { url: null, enabled: false }, "GET still answers, with the defaults, over a broken file");
    eq(typeof view.json.problem, "string", "and says why, rather than pretending nothing is wrong");

    await writeFile(cloudFile, before, "utf8");
  });

  await check("bodies that are not JSON objects are refused the same way every other settings route refuses them", async () => {
    const res = await fetch(base + "/cloud-link", { method: "POST", body: "{}" });
    eq(res.status, 415);
  });

  await new Promise((r) => server.close(r));

  await check("REQUIRED: a store account and a manager account are BOTH refused on every /cloud-link route", async () => {
    for (const principal of [
      { kind: "user", username: "clerk", role: "store" },
      { kind: "user", username: "boss", role: "manager" },
    ]) {
      const s = startServer(authAs(principal));
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      const b = `http://127.0.0.1:${s.address().port}`;
      try {
        eq((await fetch(`${b}/cloud-link`)).status, 403, `${principal.role}: GET /cloud-link refused`);
        eq((await fetch(`${b}/cloud-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403, `${principal.role}: POST /cloud-link refused`);
        eq((await fetch(`${b}/cloud-link/enroll`, { method: "POST" })).status, 403, `${principal.role}: POST /cloud-link/enroll refused`);
      } finally {
        await new Promise((r) => s.close(r));
      }
    }
  });

  await check("FEARED: a display credential is refused too — this route has no reach for it at all", async () => {
    const s = startServer(authAs({ kind: "display", displayId: "wall-1" }));
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      eq((await fetch(`${b}/cloud-link`)).status, 403);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  await check("non-vacuity: every response in this suite went through the key-material check", async () => {
    eq(responsesChecked >= 10, true, `only ${responsesChecked} responses were checked`);
  });
} finally {
  index.close();
  await rm(stateDir, { recursive: true, force: true });
}

report("cloud link API");
