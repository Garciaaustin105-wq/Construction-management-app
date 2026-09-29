// cloud/harness/admin.harness.mjs — cloud/admin/admin.mjs (CLOUD-LOGIN-SPEC.md E).
//
// FEARED: a password typed as an argument (shell history, process lists) and
// echoed back; a weak password let in by a second, looser rule; a device put
// on a site of the wrong installer; a lost race that half-applies; a reset
// that leaves the old sessions alive; a hash or salt printed to the terminal.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { randomBytes } from "node:crypto";
import { runAdmin } from "../admin/admin.mjs";
import { createMemoryStore } from "../api/memoryStore.mjs";
import { loginHandler, principalFromEvent } from "../api/login.mjs";

console.log("admin tool");

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const FAST = { N: 1024, r: 8, p: 1 };
const PW = "correct horse battery";
const PW2 = "another long passphrase";
const LOGIN = "tech@example.com";

function claimedDevice(deviceId, installerId, over = {}) {
  return {
    deviceId,
    state: "claimed",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    code: null,
    codeExpiresMs: null,
    installerId,
    siteId: null,
    expiresAtS: null,
    ...over,
  };
}
const tenancyOf = (installerId, name, extra = {}) => ({
  installers: [{ id: installerId, name }],
  orgs: [],
  groups: [],
  sites: [],
  devices: [],
  ...extra,
});

/** A store, a scripted password prompt, and a captured terminal. */
function setup(seed = {}) {
  const store = createMemoryStore(seed);
  const out = [];
  const answers = [];
  const prompts = { count: 0 };
  const deps = {
    store,
    out: (line) => out.push(String(line)),
    promptSecret: async () => {
      prompts.count++;
      if (answers.length === 0) throw new Error("the tool asked for a password nobody scripted");
      return answers.shift();
    },
    nowMs: () => NOW,
    randomBytes,
    scryptParams: FAST,
  };
  const run = (...argv) => runAdmin(argv, deps);
  const loginDeps = { store, nowMs: () => NOW, randomBytes, scryptParams: FAST, log: () => {} };
  const tryLogin = (password, login = LOGIN) =>
    loginHandler({ body: JSON.stringify({ login, password }), headers: { "content-type": "application/json" }, sourceIp: "203.0.113.5" }, loginDeps);
  const cookieOf = (res) => /^camplat_session=([A-Za-z0-9_-]{43});/.exec(res.headers["set-cookie"] ?? "")?.[1];
  const principal = (token) => principalFromEvent({ body: "", headers: { cookie: `camplat_session=${token}` }, sourceIp: "203.0.113.5" }, loginDeps);
  return { store, out, answers, prompts, deps, run, tryLogin, cookieOf, principal };
}
async function withUser(seed) {
  const t = setup(seed);
  eq(await t.run("create-installer", "inst-1", "Acme Security"), 0, "create-installer");
  t.answers.push(PW, PW);
  eq(await t.run("create-user", LOGIN, "inst-1"), 0, "create-user");
  return t;
}

await check("a password given as an argument is refused and never echoed", async () => {
  for (const argv of [
    ["create-user", LOGIN, "inst-1", "--password", "hunter2hunter2xx"],
    ["create-user", LOGIN, "inst-1", "--password=hunter2hunter2xx"],
    ["reset-password", LOGIN, "-p", "hunter2hunter2xx"],
  ]) {
    const t = setup();
    await t.run("create-installer", "inst-1", "Acme Security");
    const code = await t.run(...argv);
    eq(code, 2, `exit 2 for ${argv.join(" ").replace("hunter2hunter2xx", "***")}`);
    eq(t.out.join("\n").includes("hunter2hunter2xx"), false, "the value is not repeated");
    eq(t.prompts.count, 0, "no prompt");
    eq(await t.store.getUser(LOGIN), null, "no user created");
  }
});

await check("create-user asks twice and the user can log in", async () => {
  const t = await withUser();
  eq(t.prompts.count, 2, "asked twice");
  const u = await t.store.getUser(LOGIN);
  eq(/^usr_[0-9a-f]{16}$/.test(u.userId), true, "userId shape");
  eq(u.installerId, "inst-1", "installer");
  eq(u.sessionEpoch, 0, "epoch 0");
  eq(u.disabled, false, "active");
  eq((await t.tryLogin(PW)).statusCode, 200, "logs in");
});

await check("create-user normalizes the login", async () => {
  const t = setup();
  await t.run("create-installer", "inst-1", "Acme Security");
  t.answers.push(PW, PW);
  eq(await t.run("create-user", "Tech@Example.COM", "inst-1"), 0, "created");
  eq((await t.store.getUser(LOGIN))?.login, LOGIN, "stored lower-case");
});

await check("mismatched or weak passwords are refused with the box's reason", async () => {
  const t = setup();
  await t.run("create-installer", "inst-1", "Acme Security");
  t.answers.push(PW, PW2);
  eq(await t.run("create-user", LOGIN, "inst-1"), 1, "mismatch refused");
  t.answers.push("short", "short");
  eq(await t.run("create-user", LOGIN, "inst-1"), 1, "short refused");
  eq(t.out.join("\n").includes("at least 12 characters"), true, "the box's length reason");
  t.answers.push("Tech@Example.com", "Tech@Example.com");
  eq(await t.run("create-user", LOGIN, "inst-1"), 1, "password == login refused");
  eq(t.out.join("\n").includes("the password cannot be the username"), true, "the box's username reason");
  t.answers.push("password1234", "password1234");
  eq(await t.run("create-user", LOGIN, "inst-1"), 1, "padded common password refused");
  eq(await t.store.getUser(LOGIN), null, "no user after any refusal");
});

await check("create-user refuses an unknown installer, a duplicate login and a bad login", async () => {
  const t = await withUser();
  t.answers.push(PW2, PW2);
  eq(await t.run("create-user", "other@example.com", "inst-9"), 1, "unknown installer");
  eq(await t.store.getUser("other@example.com"), null, "not created");
  const before = await t.store.getUser(LOGIN);
  t.answers.push(PW2, PW2);
  eq(await t.run("create-user", LOGIN, "inst-1"), 1, "duplicate login");
  same(await t.store.getUser(LOGIN), before, "first user untouched");
  eq((await t.tryLogin(PW)).statusCode, 200, "old password still the one");
  eq(await t.run("create-user", "a b", "inst-1"), 1, "bad login refused before any prompt");
});

await check("reset-password ends existing sessions; only the new password works", async () => {
  const t = await withUser();
  const token = t.cookieOf(await t.tryLogin(PW));
  eq((await t.principal(token)) !== null, true, "session alive");
  t.answers.push(PW2, PW2);
  eq(await t.run("reset-password", LOGIN), 0, "reset");
  eq(await t.principal(token), null, "old session dead");
  eq((await t.tryLogin(PW)).statusCode, 401, "old password refused");
  eq((await t.tryLogin(PW2)).statusCode, 200, "new password works");
  eq(await t.run("reset-password", "nobody@example.com"), 1, "unknown login");
});

await check("disable-user ends sessions and stops logins; enable-user restores logins", async () => {
  const t = await withUser();
  const token = t.cookieOf(await t.tryLogin(PW));
  eq(await t.run("disable-user", LOGIN), 0, "disable");
  eq(await t.principal(token), null, "session dead");
  eq((await t.tryLogin(PW)).statusCode, 401, "cannot log in");
  eq(await t.run("enable-user", LOGIN), 0, "enable");
  eq((await t.tryLogin(PW)).statusCode, 200, "can log in again");
});

await check("create-org and create-site build a valid tree; bad parents are refused", async () => {
  const t = await withUser();
  eq(await t.run("create-installer", "inst-1", "Again"), 1, "installer exists");
  eq(await t.run("create-org", "inst-1", "org-1", "Car Wash Co"), 0, "org");
  eq(await t.run("create-site", "inst-1", "org-1", "site-1", "Main St"), 0, "site");
  const tn = await t.store.getTenancy("inst-1");
  same(tn.orgs, [{ id: "org-1", installerId: "inst-1", name: "Car Wash Co", privacy: { offered: false, installerBlocked: false } }], "org, privacy off by default");
  same(tn.sites, [{ id: "site-1", orgId: "org-1", groupId: null, name: "Main St" }], "site");
  eq(await t.run("create-site", "inst-1", "org-9", "site-2", "Nowhere"), 1, "unknown org");
  eq(await t.run("create-org", "inst-9", "org-2", "Ghost"), 1, "unknown installer");
  eq(await t.run("create-site", "inst-1", "org-1", "site-1", "Duplicate"), 1, "duplicate site id");
  same((await t.store.getTenancy("inst-1")).sites.length, 1, "still one site");
});

async function withSites() {
  const t = await withUser({
    devices: [
      claimedDevice("dev-mine", "inst-1"),
      claimedDevice("dev-theirs", "inst-2"),
      { ...claimedDevice("dev-new", null), state: "unclaimed", code: "AAAA-BBBB-C", codeExpiresMs: NOW + 3600_000, expiresAtS: Math.ceil((NOW + 3600_000) / 1000) },
    ],
    tenancies: {
      "inst-2": tenancyOf("inst-2", "Rival Alarms", {
        orgs: [{ id: "org-r", installerId: "inst-2", name: "Rival Org", privacy: { offered: false, installerBlocked: false } }],
        sites: [{ id: "site-r", orgId: "org-r", groupId: null, name: "Rival Site" }],
      }),
    },
  });
  await t.run("create-org", "inst-1", "org-1", "Car Wash Co");
  await t.run("create-site", "inst-1", "org-1", "site-1", "Main St");
  await t.run("create-site", "inst-1", "org-1", "site-2", "Oak Ave");
  return t;
}

await check("assign-device puts a claimed device on a site, and re-running it is safe", async () => {
  const t = await withSites();
  eq(await t.run("assign-device", "inst-1", "dev-mine", "site-1"), 0, "assign");
  eq(await t.run("assign-device", "inst-1", "dev-mine", "site-1"), 0, "again");
  same((await t.store.getTenancy("inst-1")).devices, [{ deviceId: "dev-mine", siteId: "site-1" }], "one entry");
  eq((await t.store.getDevice("dev-mine")).siteId, "site-1", "device record");
  eq(await t.run("assign-device", "inst-1", "dev-mine", "site-2"), 0, "move");
  same((await t.store.getTenancy("inst-1")).devices, [{ deviceId: "dev-mine", siteId: "site-2" }], "moved, not duplicated");
  eq((await t.store.getDevice("dev-mine")).siteId, "site-2", "device record moved");
});

await check("assign-device refuses another installer's device, an unclaimed device and another installer's site", async () => {
  const t = await withSites();
  const before = JSON.stringify([await t.store.getTenancyRecord("inst-1"), await t.store.getTenancyRecord("inst-2")]);
  eq(await t.run("assign-device", "inst-1", "dev-theirs", "site-1"), 1, "their device");
  eq(await t.run("assign-device", "inst-1", "dev-new", "site-1"), 1, "unclaimed device");
  eq(await t.run("assign-device", "inst-1", "dev-mine", "site-r"), 1, "their site");
  eq(await t.run("assign-device", "inst-1", "dev-ghost", "site-1"), 1, "unknown device");
  eq(JSON.stringify([await t.store.getTenancyRecord("inst-1"), await t.store.getTenancyRecord("inst-2")]), before, "no tenancy changed");
  eq((await t.store.getDevice("dev-theirs")).siteId, null, "their device untouched");
  eq((await t.store.getDevice("dev-mine")).siteId, null, "mine untouched");
});

await check("a lost putTenancy race changes nothing and says so", async () => {
  const t = await withSites();
  const realPut = t.store.putTenancy;
  let raced = false;
  t.deps.store = {
    ...t.store,
    putTenancy: async (installerId, tenancy, opts) => {
      if (!raced) {
        raced = true; // another admin wins first, with the same ifVersion
        const theirs = structuredClone(tenancy);
        theirs.sites = theirs.sites.filter((s) => s.id !== "site-2");
        theirs.devices = [];
        eq(await realPut(installerId, theirs, opts), true, "the other writer lands");
      }
      return realPut(installerId, tenancy, opts);
    },
  };
  eq(await t.run("assign-device", "inst-1", "dev-mine", "site-1"), 1, "lost race exits 1");
  eq(t.out.join("\n").includes("nothing was changed"), true, "says nothing was changed");
  const tn = await t.store.getTenancy("inst-1");
  same(tn.devices, [], "the other writer's tree stands");
  eq(tn.sites.some((s) => s.id === "site-2"), false, "their change kept");
  eq((await t.store.getDevice("dev-mine")).siteId, null, "the device record was not written after the lost race");
});

await check("no output ever contains a hash, a salt or a session token", async () => {
  const t = await withUser();
  const token = t.cookieOf(await t.tryLogin(PW));
  t.answers.push(PW2, PW2);
  await t.run("reset-password", LOGIN);
  await t.run("disable-user", LOGIN);
  await t.run("enable-user", LOGIN);
  const u = await t.store.getUser(LOGIN);
  const text = t.out.join("\n");
  for (const needle of [u.password.salt, u.password.key, token, PW, PW2]) {
    eq(text.includes(needle), false, `output must not contain ${needle.slice(0, 10)}...`);
  }
});

await check("an unknown command or missing arguments exit 2 with usage", async () => {
  const t = setup();
  eq(await t.run("drop-everything"), 2, "unknown command");
  eq(await t.run("create-org", "inst-1"), 2, "missing arguments");
  eq(await t.run(), 2, "no command");
  eq(t.prompts.count, 0, "no prompt");
});

report("admin tool");
