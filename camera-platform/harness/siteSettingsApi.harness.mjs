/**
 * GET/POST /site-settings and GET /site, end to end through the real server
 * (agent/api-server.mjs -> agent/site-settings.mjs -> dist/siteSettings.js).
 * SITE-SETTINGS-SPEC.md's own "Tests that matter" for this half: a missing
 * site.json is the defaults; a corrupt one refuses the next save instead of
 * being silently rebuilt; a preset applies once, on a real site-type change,
 * and never again while the operator's own switches stand; the version and
 * trust-anchor read report their own reason when unreadable, and the public
 * key ids only, never a PEM; every save is audited with fields, never
 * values; and no camera credential or URL ever reaches any of it.
 *
 * Also proves the wiring this spec asks for in agent/camera-ai-settings.mjs
 * and the /activity route: GET /camera-ai-settings' own `timeZone` becomes
 * the site's effective zone once one is set, and /activity fills in a
 * missing `tz` from the same effective zone rather than refusing it.
 *
 * THE FEARED FAILURES, by name:
 * - a bad hand edit to site.json being rebuilt from empty on the next save,
 *   silently discarding a displayName or timeZone that was already there;
 * - a site-type preset re-stamping a feature switch the installer already
 *   turned back on by hand, on a save that never actually changed the type;
 * - a store account (or a display) reaching /site-settings at all, or
 *   /site-settings leaking a camera's rtsp:// address or password anywhere
 *   in its JSON;
 * - a trusted key's PEM reaching the response, instead of only its id.
 */
import { mkdtemp, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer } from "../agent/api-server.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { indexPathFor } from "../agent/config.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("site settings API");

const CAM_PW = "site-s3cret";
const audits = [];
const authAs = (principal) => ({
  principalOf: () => principal,
  handle: async () => false,
  audit: (event, _req, fields) => audits.push({ event, ...fields }),
});
const installer = authAs({ kind: "user", username: "tech", role: "installer" });

const stateDir = await mkdtemp(join(tmpdir(), "camplat-siteset-"));
const appDir = await mkdtemp(join(tmpdir(), "camplat-siteapp-"));
const config = {
  siteId: "bench",
  storeRoots: [join(stateDir, "disk0")],
  credentials: { username: "svc", password: "svc-pw" },
  cameras: [{ cameraId: "cam-1", url: `rtsp://admin:${CAM_PW}@10.0.0.5:554/main` }],
};
await writeFile(join(stateDir, "config.json"), JSON.stringify(config));

const index = openIndex(indexPathFor(stateDir));
const startServer = (auth) => createApiServer({ stateDir, config, index, auth, siteSettingsAppDir: appDir });
let server = startServer(installer);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let base = `http://127.0.0.1:${server.address().port}`;

const send = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json };
};
const noSecrets = (text, what) => {
  if (text.includes(CAM_PW) || /rtsp:\/\//i.test(text)) throw new Error(`${what} carries a camera credential or address: ${text}`);
};
const siteFile = join(stateDir, "site.json");

try {
  await check("GET /site-settings on a fresh box: exactly the defaults, no credential anywhere", async () => {
    const r = await send("GET", "/site-settings");
    eq(r.status, 200);
    noSecrets(r.text, "GET /site-settings");
    eq(r.json.ok, true);
    eq(r.json.settings, { displayName: null, timeZone: null, siteType: null, features: { activity: true, managerRules: false }, openHours: null });
    eq(r.json.problem, null);
    eq(typeof r.json.systemTimeZone, "string");
    eq(r.json.effectiveTimeZone, r.json.systemTimeZone, "no site zone set yet: effective falls back to the system zone");
    eq(r.json.version, null, "no VERSION file yet");
    eq(typeof r.json.versionProblem, "string", "unreadable reports its reason, never a blank");
    eq(r.json.trustedKeyIds, [], "no trust anchor yet");
    eq(typeof r.json.trustedKeysProblem, "string");
    eq(r.json.license, "No license service configured yet");
  });

  await check("GET /site on a fresh box matches: null display name, the system zone, activity on", async () => {
    const r = await send("GET", "/site");
    eq(r.status, 200);
    eq(r.json, { ok: true, displayName: null, timeZone: (await send("GET", "/site-settings")).json.systemTimeZone, features: { activity: true, managerRules: false } });
  });

  await check("the version and trust anchor read real files, and NEVER a PEM", async () => {
    await writeFile(join(appDir, "VERSION"), "0123456789abcdefLONGER-THAN-12\n");
    await utimes(join(appDir, "VERSION"), new Date("2026-01-15T00:00:00Z"), new Date("2026-01-15T00:00:00Z"));
    const keysFile = join(appDir, "trusted-keys.json");
    await writeFile(keysFile, JSON.stringify({
      keys: [
        { id: "release-2026", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nSECRETPEM\n-----END PUBLIC KEY-----" },
        { id: "revoked-2024", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nOTHER\n-----END PUBLIC KEY-----", revoked: true },
      ],
    }));
    process.env.CAMPLAT_TRUSTED_KEYS = keysFile;
    const s = startServer(installer);
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
      const res = await fetch(`${b}/site-settings`);
      const text = await res.text();
      const json = JSON.parse(text);
      eq(json.version, { version: "0123456789ab", installedAtUtc: new Date("2026-01-15T00:00:00Z").toISOString() });
      eq(json.versionProblem, null);
      eq(json.trustedKeyIds, ["release-2026"], "only the non-revoked key's id");
      eq(text.includes("SECRETPEM"), false, "FEARED: the PEM itself must never reach the response");
      eq(text.includes("OTHER"), false);
      eq(json.trustedKeysProblem, null);
    } finally {
      await new Promise((r) => s.close(r));
      delete process.env.CAMPLAT_TRUSTED_KEYS;
    }
  });

  await check("an unknown feature key or a bad IANA zone is a 400 listing every problem at once", async () => {
    const r = await send("POST", "/site-settings", { timeZone: "Not/AZone", siteType: "not-a-type", features: { nope: true } });
    eq(r.status, 400);
    const fields = r.json.errors.map((e) => e.field).sort();
    eq(fields.includes("timeZone"), true);
    eq(fields.includes("siteType"), true);
    eq(fields.includes("features.nope"), true);
    eq(r.json.errors.length >= 3, true, "every problem, not fix-and-resave one at a time");
    const after = await send("GET", "/site-settings");
    eq(after.json.settings.siteType, null, "the invalid body was never saved");
  });

  await check("choosing a site type for the first time applies its preset (home: activity off)", async () => {
    const r = await send("POST", "/site-settings", { displayName: "Pflugerville Car Wash", timeZone: "America/Chicago", siteType: "home" });
    eq(r.status, 200);
    eq(r.json.settings, { displayName: "Pflugerville Car Wash", timeZone: "America/Chicago", siteType: "home", features: { activity: false, managerRules: false }, openHours: null });
    const view = await send("GET", "/site-settings");
    eq(view.json.settings, r.json.settings, "GET reflects the save at once");
    eq(view.json.effectiveTimeZone, "America/Chicago", "the site's own zone is now effective");
    const stored = JSON.parse(await readFile(siteFile, "utf8"));
    noSecrets(JSON.stringify(stored), "site.json");
    eq(stored.version, 1);
    eq(typeof stored.updatedUtc, "string");
    eq(stored.updatedBy, "tech");
  });

  await check("REQUIRED: the operator flips the preset's own switch back on by hand, in the same site type -- it takes", async () => {
    const r = await send("POST", "/site-settings", { displayName: "Pflugerville Car Wash", timeZone: "America/Chicago", siteType: "home", features: { activity: true } });
    eq(r.status, 200);
    eq(r.json.settings.features, { activity: true, managerRules: false });
  });

  await check("REQUIRED: a preset never applies again while the site type is unchanged -- resaving the SAME type never stamps back over the operator's own switch", async () => {
    const r = await send("POST", "/site-settings", { displayName: "Pflugerville Car Wash - Front", timeZone: "America/Chicago", siteType: "home", features: { activity: true } });
    eq(r.status, 200);
    eq(r.json.settings.features, { activity: true, managerRules: false }, "still on -- home's own preset (off) never silently reapplied");
    eq(r.json.settings.displayName, "Pflugerville Car Wash - Front", "the field that WAS meant to change, did");
  });

  await check("changing to a genuinely different site type applies the NEW type's own preset", async () => {
    const r = await send("POST", "/site-settings", { displayName: "Pflugerville Car Wash - Front", timeZone: "America/Chicago", siteType: "retail" });
    eq(r.status, 200);
    eq(r.json.settings.siteType, "retail");
    eq(r.json.settings.features, { activity: true, managerRules: true }, "retail's own preset (on) -- happens to already be on for activity, but managerRules flips true here, proving the preset actually took effect on this real type change");
  });

  await check("FEARED: every save writes an audit line naming who and which FIELDS changed -- never a value, never a credential", async () => {
    noSecrets(JSON.stringify(audits), "audit log");
    const saves = audits.filter((a) => a.event === "site.settings");
    eq(saves.length >= 4, true);
    eq(saves.every((a) => a.actor === "tech"), true);
    eq(saves.every((a) => Array.isArray(a.fields)), true);
    eq(saves.some((a) => JSON.stringify(a).includes("America/Chicago")), false, "a value never appears, only the field name");
  });

  await check("bodies that are not JSON objects are refused the same way every other settings route refuses them", async () => {
    const res = await fetch(base + "/site-settings", { method: "POST", body: "{}" });
    eq(res.status, 415);
    eq((await send("POST", "/site-settings", [1])).status, 400);
  });

  await server.close();

  await check("FEARED: a store account and a display credential are BOTH refused on /site-settings; /site is open to both", async () => {
    for (const principal of [{ kind: "user", username: "clerk", role: "store" }, { kind: "display", displayId: "wall-1" }]) {
      const s = startServer(authAs(principal));
      await new Promise((r) => s.listen(0, "127.0.0.1", r));
      const b = `http://127.0.0.1:${s.address().port}`;
      try {
        eq((await fetch(`${b}/site-settings`)).status, 403, `${principal.role ?? principal.kind}: GET /site-settings refused`);
        eq((await fetch(`${b}/site-settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403, `${principal.role ?? principal.kind}: POST /site-settings refused`);
        eq((await fetch(`${b}/site`)).status, 200, `${principal.role ?? principal.kind}: GET /site allowed`);
      } finally {
        await new Promise((r) => s.close(r));
      }
    }
  });

  server = startServer(installer);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  await check("FEARED: a corrupt site.json (a bad hand edit, not this route's own writing) refuses the next save instead of silently wiping what was there", async () => {
    const before = await readFile(siteFile, "utf8");
    eq(JSON.parse(before).siteType, "retail", "real settings are on disk before the corruption");

    await writeFile(siteFile, "{ not valid json", "utf8");
    const r = await send("POST", "/site-settings", { displayName: "New Name" });
    eq(r.status, 409, "refused rather than rebuilt from empty");
    eq(r.json.code, "site_settings_unreadable");

    const onDisk = await readFile(siteFile, "utf8");
    eq(onDisk, "{ not valid json", "the file itself was never overwritten by the refused save");

    // A GET, meanwhile, still answers -- with the defaults and a problem, per
    // "the caller shows what it safely can" (agent/camera-ai-settings.mjs's
    // own discipline), never a 500 over a file a save has already refused.
    const view = await send("GET", "/site-settings");
    eq(view.status, 200);
    eq(view.json.settings.siteType, null, "defaults, not a guess at the broken file's content");
    eq(typeof view.json.problem, "string");

    await writeFile(siteFile, before, "utf8");
  });

  await check("GET /camera-ai-settings' own timeZone becomes the site's effective zone once one is set", async () => {
    const r = await fetch(base + "/camera-ai-settings");
    const json = await res_json(r);
    eq(json.timeZone, "America/Chicago", "the site zone set above, not the NVR's own system zone");
  });
  async function res_json(r) { return JSON.parse(await r.text()); }

  await check("REQUIRED: /activity fills in a missing tz from the site's effective zone, rather than refusing it", async () => {
    const withoutTz = await send("GET", "/activity?range=24h");
    eq(withoutTz.status, 200, "no longer bad_tz: the route supplies the site's own effective zone");
    eq(withoutTz.json.tz, "America/Chicago");

    const explicit = await send("GET", "/activity?range=24h&tz=UTC");
    eq(explicit.status, 200);
    eq(explicit.json.tz, "UTC", "an explicit tz from the client is never second-guessed");
  });

  await check("clearing the site zone back to null: camera-ai-settings and /activity both fall back to the system zone again", async () => {
    await send("POST", "/site-settings", { displayName: "Pflugerville Car Wash - Front", siteType: "retail", timeZone: null });
    const sysZone = (await send("GET", "/site-settings")).json.systemTimeZone;
    eq((await res_json(await fetch(base + "/camera-ai-settings"))).timeZone, sysZone);
    eq((await send("GET", "/activity?range=24h")).json.tz, sysZone);
  });

  await check("REQUIRED: the activity feature switch - off gives 404 feature_off on /activity and /activity-page, on is unchanged", async () => {
    // on (retail, from the save above): both routes work normally.
    eq((await send("GET", "/activity?range=24h")).status, 200, "on: /activity answers normally");
    eq((await fetch(base + "/activity-page")).status, 200, "on: /activity-page serves the page");
    eq((await send("GET", "/site")).json.features.activity, true, "on: the page uses this to show the nav link");

    // switch it off (home's own preset).
    const off = await send("POST", "/site-settings", { siteType: "home" });
    eq(off.json.settings.features.activity, false);

    const activityOff = await send("GET", "/activity?range=24h");
    eq(activityOff.status, 404, "FEARED: off must be 404, never 403 (403 would read as a permission problem, not 'this feature does not exist here')");
    eq(activityOff.json.code, "feature_off");

    const pageOff = await fetch(base + "/activity-page");
    eq(pageOff.status, 404);
    eq((await pageOff.json()).code, "feature_off");

    eq((await send("GET", "/site")).json.features.activity, false, "off: the page uses this to hide the nav link");

    // a store account gets the exact same 404 -- the feature is off for
    // EVERYONE, not merely hidden from one role.
    const clerkServer = startServer(authAs({ kind: "user", username: "clerk", role: "store" }));
    await new Promise((r) => clerkServer.listen(0, "127.0.0.1", r));
    try {
      const cb = `http://127.0.0.1:${clerkServer.address().port}`;
      const r = await fetch(`${cb}/activity?range=24h`);
      eq(r.status, 404);
      eq((await r.json()).code, "feature_off");
    } finally {
      await new Promise((r) => clerkServer.close(r));
    }

    // switch it back on: unchanged behaviour, per "Tests that matter".
    await send("POST", "/site-settings", { siteType: "home", features: { activity: true } });
    eq((await send("GET", "/activity?range=24h")).status, 200, "back on: unchanged");
    eq((await fetch(base + "/activity-page")).status, 200, "back on: unchanged");
  });
} finally {
  await new Promise((r) => server.close(r));
  index.close();
  await rm(stateDir, { recursive: true, force: true });
  await rm(appDir, { recursive: true, force: true });
}

report("site settings API");
