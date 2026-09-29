/**
 * The setup tool Austin runs himself, by hand, against production
 * (cloud/CLOUD-LOGIN-SPEC.md section E, "The setup tool"). It creates
 * installers and their logged-in users, builds their org/site tree, and
 * assigns a claimed device to a site -- everything the dev server's
 * "place it on site-dev" glue used to do for free, now that a real
 * installer login exists.
 *
 * `runAdmin(argv, deps)` is the whole tool: pure command dispatch over an
 * injected `deps = { store, promptSecret(question) -> Promise<string>,
 * out(line), nowMs(), randomBytes(n), scryptParams? }`, returning an exit
 * code. `deps.store` is read fresh inside every command handler, never
 * cached across a call, so a caller (a test, or a future retry wrapper) that
 * swaps `deps.store` between commands is honoured immediately.
 *
 * FEARED (this file's own harness, cloud/harness/admin.harness.mjs, header):
 * a password typed as an argument (shell history, process lists) and echoed
 * back; a weak password let in by a second, looser rule than the box's own;
 * a device put on a site of the wrong installer; a lost race that
 * half-applies; a reset that leaves the old sessions alive; a hash or salt
 * printed to the terminal.
 *
 * This file never reimplements a rule another file already owns: password
 * strength is `validatePassword` (cloud/contracts/auth.ts, re-exported from
 * the box's own contracts/access.ts), password hashing is `hashPassword`
 * (cloud/api/login.mjs, built and tested, never edited here), and tenancy
 * shape is `checkTenancy` (cloud/contracts/tenancy.ts) -- every org/site/
 * device change here builds the CANDIDATE tree in memory and lets
 * `checkTenancy` accept or refuse it, rather than hand-rolling "does this
 * org already exist" checks that could drift from that contract.
 *
 * Compiled contracts are dynamically imported from `cloud/dist/...`, the
 * same lazy pattern cloud/api/claim.mjs and cloud/api/login.mjs use, so this
 * file itself stays plain ESM that loads even before `tsc` has run once.
 *
 * `main()` (guarded so importing this module runs nothing) is not wired to
 * a real store yet -- that is the AWS spec's job -- so it only reports that
 * and exits 1.
 */

import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { hashPassword } from "../api/login.mjs";

// ---------------------------------------------------------------------------
// Compiled, pure contracts -- lazily imported so this file loads even before
// `tsc` has produced cloud/dist/ once (the same reasoning cloud/api/login.mjs
// and cloud/api/claim.mjs give for their own lazy imports).
// ---------------------------------------------------------------------------

async function loadAuthContract() {
  return import("../dist/cloud/contracts/auth.js");
}

async function loadTenancyContract() {
  return import("../dist/cloud/contracts/tenancy.js");
}

// ---------------------------------------------------------------------------
// Usage / messages -- fixed text only. NOTHING here ever interpolates an
// argument value that could be (or contain) a password.
// ---------------------------------------------------------------------------

const USAGE = [
  "usage: admin <command> [args]",
  "",
  "commands:",
  "  create-installer <installerId> <name>",
  "  create-user <login> <installerId>",
  "  reset-password <login>",
  "  disable-user <login>",
  "  enable-user <login>",
  "  create-org <installerId> <orgId> <name>",
  "  create-site <installerId> <orgId> <siteId> <name>",
  "  assign-device <installerId> <deviceId> <siteId>",
  "",
  "a password is never a command-line argument -- it would land in shell",
  "history and every process listing on this machine. Omit it and the tool",
  "prompts for it, twice, with echo off.",
].join("\n");

const PASSWORD_ARG_MESSAGE =
  "refusing: a password must never be given as a command-line argument -- omit it and the tool will prompt for it";

const RACE_MESSAGE =
  "someone else changed this installer's setup at the same moment; nothing was changed -- run it again";

const USER_RACE_MESSAGE =
  "someone else changed this user's account at the same moment; nothing was changed -- run it again";

/** "--password", "--password=...", or "-p" -- checked against EVERY argument,
 *  not just the ones a given command happens to expect, so a password typed
 *  in the wrong slot is still caught (CLOUD-LOGIN-SPEC.md section E,
 *  "Rules for every command"). */
function isPasswordLookingArg(arg) {
  return typeof arg === "string" && (arg === "--password" || arg.startsWith("--password=") || arg === "-p");
}

function usageExit(deps, forCommand) {
  deps.out(forCommand ? `usage: ${forCommand}` : USAGE);
  return 2;
}

function printTenancyProblems(deps, problems) {
  deps.out("this change would leave the installer's tenancy tree invalid, so nothing was written:");
  for (const problem of problems) {
    deps.out(`  ${problem.path}: ${problem.reason}`);
  }
}

// ---------------------------------------------------------------------------
// create-installer <installerId> <name>
// ---------------------------------------------------------------------------

async function cmdCreateInstaller(args, deps) {
  if (args.length !== 2) return usageExit(deps, "create-installer <installerId> <name>");
  const [installerId, name] = args;
  const { store } = deps;

  const existing = await store.getTenancyRecord(installerId);
  if (existing !== null) {
    deps.out(`installer ${installerId} already exists`);
    return 1;
  }

  const tenancy = { installers: [{ id: installerId, name }], orgs: [], groups: [], sites: [], devices: [] };
  const { checkTenancy } = await loadTenancyContract();
  const verdict = checkTenancy(tenancy);
  if (!verdict.ok) {
    printTenancyProblems(deps, verdict.problems);
    return 1;
  }

  const written = await store.putTenancy(installerId, tenancy, { ifVersion: null });
  if (!written) {
    deps.out(RACE_MESSAGE);
    return 1;
  }
  deps.out(`created installer ${installerId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// create-user <login> <installerId>
// ---------------------------------------------------------------------------

async function cmdCreateUser(args, deps) {
  if (args.length !== 2) return usageExit(deps, "create-user <login> <installerId>");
  const [rawLogin, installerId] = args;
  const { store } = deps;
  const auth = await loadAuthContract();

  // Everything that does not need a password is checked BEFORE any prompt
  // (CLOUD-LOGIN-SPEC.md section E, "Rules for every command"): login shape,
  // then the installer exists, then the login is not already taken.
  const normalized = auth.normalizeLogin(rawLogin);
  if (normalized === null) {
    deps.out(`"${rawLogin}" is not a valid login (3 to 64 characters, lower-case letters, digits, or . _ @ + -, no spaces)`);
    return 1;
  }
  const tenancyRecord = await store.getTenancyRecord(installerId);
  if (tenancyRecord === null) {
    deps.out(`unknown installer: ${installerId}`);
    return 1;
  }
  const already = await store.getUser(normalized);
  if (already !== null) {
    deps.out(`a user already exists for login ${normalized}`);
    return 1;
  }

  const first = await deps.promptSecret("password: ");
  const second = await deps.promptSecret("confirm password: ");
  if (first !== second) {
    deps.out("the two entries did not match -- nothing was created");
    return 1;
  }
  const verdict = auth.validatePassword(first, normalized);
  if (verdict.kind !== "ok") {
    deps.out(verdict.reason);
    return 1;
  }

  const passwordRecord = await hashPassword(first, { scryptParams: deps.scryptParams, randomBytes: deps.randomBytes });
  const user = {
    userId: "usr_" + deps.randomBytes(8).toString("hex"),
    login: normalized,
    installerId,
    password: passwordRecord,
    disabled: false,
    sessionEpoch: 0,
    createdMs: deps.nowMs(),
  };
  const written = await store.putUser(user, { ifAbsent: true });
  if (!written) {
    // Lost a race against another create-user for the same login since the
    // check above -- not the tenancy race message (this is a user record,
    // not a tenancy tree), but the same shape of refusal.
    deps.out(`a user already exists for login ${normalized}`);
    return 1;
  }
  deps.out(`created user ${normalized}`);
  return 0;
}

// ---------------------------------------------------------------------------
// reset-password <login>
// ---------------------------------------------------------------------------

async function cmdResetPassword(args, deps) {
  if (args.length !== 1) return usageExit(deps, "reset-password <login>");
  const [rawLogin] = args;
  const { store } = deps;
  const auth = await loadAuthContract();

  const normalized = auth.normalizeLogin(rawLogin);
  const user = normalized === null ? null : await store.getUser(normalized);
  if (user === null) {
    deps.out(`unknown login: ${rawLogin}`);
    return 1;
  }

  const first = await deps.promptSecret("new password: ");
  const second = await deps.promptSecret("confirm new password: ");
  if (first !== second) {
    deps.out("the two entries did not match -- nothing was changed");
    return 1;
  }
  const verdict = auth.validatePassword(first, normalized);
  if (verdict.kind !== "ok") {
    deps.out(verdict.reason);
    return 1;
  }

  const passwordRecord = await hashPassword(first, { scryptParams: deps.scryptParams, randomBytes: deps.randomBytes });
  // sessionEpoch + 1 signs out every session issued under the old password
  // (cloud/contracts/auth.ts's sessionState compares this against the
  // session's own captured epoch) -- the whole mechanism, no session table
  // scan needed.
  const updated = { ...user, password: passwordRecord, sessionEpoch: user.sessionEpoch + 1 };
  const written = await store.putUser(updated, { ifEpoch: user.sessionEpoch });
  if (!written) {
    deps.out(USER_RACE_MESSAGE);
    return 1;
  }
  deps.out(`reset the password for ${normalized}`);
  return 0;
}

// ---------------------------------------------------------------------------
// disable-user <login> / enable-user <login>
// ---------------------------------------------------------------------------

async function cmdDisableUser(args, deps) {
  if (args.length !== 1) return usageExit(deps, "disable-user <login>");
  const [rawLogin] = args;
  const { store } = deps;
  const auth = await loadAuthContract();

  const normalized = auth.normalizeLogin(rawLogin);
  const user = normalized === null ? null : await store.getUser(normalized);
  if (user === null) {
    deps.out(`unknown login: ${rawLogin}`);
    return 1;
  }
  // Disable bumps the epoch too (CLOUD-LOGIN-SPEC.md section E): a disabled
  // account's existing sessions must not keep working just because nothing
  // else about the password changed.
  const updated = { ...user, disabled: true, sessionEpoch: user.sessionEpoch + 1 };
  const written = await store.putUser(updated, { ifEpoch: user.sessionEpoch });
  if (!written) {
    deps.out(USER_RACE_MESSAGE);
    return 1;
  }
  deps.out(`disabled ${normalized}`);
  return 0;
}

async function cmdEnableUser(args, deps) {
  if (args.length !== 1) return usageExit(deps, "enable-user <login>");
  const [rawLogin] = args;
  const { store } = deps;
  const auth = await loadAuthContract();

  const normalized = auth.normalizeLogin(rawLogin);
  const user = normalized === null ? null : await store.getUser(normalized);
  if (user === null) {
    deps.out(`unknown login: ${rawLogin}`);
    return 1;
  }
  // Enabling does NOT bump the epoch: nothing about the password changed,
  // and the epoch bump disable already did is what keeps a session created
  // before the disable permanently dead -- there is no session to revoke
  // here that disable did not already revoke.
  const updated = { ...user, disabled: false };
  const written = await store.putUser(updated, { ifEpoch: user.sessionEpoch });
  if (!written) {
    deps.out(USER_RACE_MESSAGE);
    return 1;
  }
  deps.out(`enabled ${normalized}`);
  return 0;
}

// ---------------------------------------------------------------------------
// create-org <installerId> <orgId> <name>
// ---------------------------------------------------------------------------

async function cmdCreateOrg(args, deps) {
  if (args.length !== 3) return usageExit(deps, "create-org <installerId> <orgId> <name>");
  const [installerId, orgId, name] = args;
  const { store } = deps;

  const record = await store.getTenancyRecord(installerId);
  if (record === null) {
    deps.out(`unknown installer: ${installerId}`);
    return 1;
  }

  // The documented default: no client-visible privacy switch until an
  // installer explicitly turns it on for that org (CLOUD-B1-SPEC.md section 3).
  const nextTenancy = {
    ...record.tenancy,
    orgs: [
      ...record.tenancy.orgs,
      { id: orgId, installerId, name, privacy: { offered: false, installerBlocked: false } },
    ],
  };
  const { checkTenancy } = await loadTenancyContract();
  const verdict = checkTenancy(nextTenancy);
  if (!verdict.ok) {
    printTenancyProblems(deps, verdict.problems);
    return 1;
  }

  const written = await store.putTenancy(installerId, nextTenancy, { ifVersion: record.version });
  if (!written) {
    deps.out(RACE_MESSAGE);
    return 1;
  }
  deps.out(`created org ${orgId} under installer ${installerId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// create-site <installerId> <orgId> <siteId> <name>
// ---------------------------------------------------------------------------

async function cmdCreateSite(args, deps) {
  if (args.length !== 4) return usageExit(deps, "create-site <installerId> <orgId> <siteId> <name>");
  const [installerId, orgId, siteId, name] = args;
  const { store } = deps;

  const record = await store.getTenancyRecord(installerId);
  if (record === null) {
    deps.out(`unknown installer: ${installerId}`);
    return 1;
  }

  const nextTenancy = {
    ...record.tenancy,
    sites: [...record.tenancy.sites, { id: siteId, orgId, groupId: null, name }],
  };
  // checkTenancy alone is what catches an unknown org (dangling_reference)
  // and a duplicate site id (duplicate_id) -- no separate hand-rolled lookup
  // that could drift from that contract (build rule 3, one owner per file).
  const { checkTenancy } = await loadTenancyContract();
  const verdict = checkTenancy(nextTenancy);
  if (!verdict.ok) {
    printTenancyProblems(deps, verdict.problems);
    return 1;
  }

  const written = await store.putTenancy(installerId, nextTenancy, { ifVersion: record.version });
  if (!written) {
    deps.out(RACE_MESSAGE);
    return 1;
  }
  deps.out(`created site ${siteId} under org ${orgId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// assign-device <installerId> <deviceId> <siteId>
// ---------------------------------------------------------------------------

async function cmdAssignDevice(args, deps) {
  if (args.length !== 3) return usageExit(deps, "assign-device <installerId> <deviceId> <siteId>");
  const [installerId, deviceId, siteId] = args;
  const { store } = deps;

  // Every check that does not write anything happens first, and in full,
  // before either write below -- a refusal here must leave both the
  // tenancy tree and the device record completely untouched.
  const record = await store.getTenancyRecord(installerId);
  if (record === null) {
    deps.out(`unknown installer: ${installerId}`);
    return 1;
  }
  const site = record.tenancy.sites.find((s) => s.id === siteId);
  if (site === undefined) {
    deps.out(`installer ${installerId} has no site ${siteId}`);
    return 1;
  }
  const device = await store.getDevice(deviceId);
  if (device === null) {
    deps.out(`unknown device: ${deviceId}`);
    return 1;
  }
  if (device.state !== "claimed") {
    deps.out(`device ${deviceId} is not claimed, so it cannot be assigned to a site`);
    return 1;
  }
  if (device.installerId !== installerId) {
    deps.out(`device ${deviceId} was claimed by a different installer`);
    return 1;
  }

  // Replace any existing entry for this device (CLOUD-LOGIN-SPEC.md section
  // E) rather than appending -- re-running the same command, or moving the
  // device to a different site, must never duplicate it in the tree.
  const nextDevices = record.tenancy.devices.filter((d) => d.deviceId !== deviceId);
  nextDevices.push({ deviceId, siteId });
  const nextTenancy = { ...record.tenancy, devices: nextDevices };

  const { checkTenancy } = await loadTenancyContract();
  const verdict = checkTenancy(nextTenancy);
  if (!verdict.ok) {
    printTenancyProblems(deps, verdict.problems);
    return 1;
  }

  // Tenancy write first; only once it lands does the device record's own
  // siteId get written (CLOUD-LOGIN-SPEC.md section E). If this first write
  // loses its race, nothing else is written at all.
  const tenancyWritten = await store.putTenancy(installerId, nextTenancy, { ifVersion: record.version });
  if (!tenancyWritten) {
    deps.out(RACE_MESSAGE);
    return 1;
  }

  const deviceWritten = await store.putDevice({ ...device, siteId }, { ifState: "claimed" });
  if (!deviceWritten) {
    deps.out(
      `the tenancy record for installer ${installerId} now lists ${deviceId} on ${siteId}, but the device record itself could not be updated (its claim state changed at the same moment) -- the tenancy half landed, the device half did not; run assign-device again to finish`,
    );
    return 1;
  }

  deps.out(`assigned ${deviceId} to ${siteId}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one setup-tool command and return its exit code. `argv` is the
 * command and its arguments (no leading `node`/script-path entries -- see
 * cloud/harness/admin.harness.mjs's own `run(...argv) => runAdmin(argv, deps)`).
 *
 * @param {string[]} argv
 * @param {{
 *   store: import("../api/store.mjs").Store,
 *   promptSecret: (question: string) => Promise<string>,
 *   out: (line: string) => void,
 *   nowMs: () => number,
 *   randomBytes: (n: number) => Buffer,
 *   scryptParams?: { N: number, r: number, p: number },
 * }} deps
 * @returns {Promise<number>}
 */
export async function runAdmin(argv, deps) {
  const list = Array.isArray(argv) ? argv : [];

  // A password-looking argument is refused before anything else -- before
  // the command is even looked up -- and its value is never repeated
  // anywhere in the output (CLOUD-LOGIN-SPEC.md section E, "Rules for every
  // command").
  if (list.some(isPasswordLookingArg)) {
    deps.out(PASSWORD_ARG_MESSAGE);
    deps.out(USAGE);
    return 2;
  }

  const [command, ...rest] = list;
  if (command === undefined) {
    deps.out(USAGE);
    return 2;
  }

  switch (command) {
    case "create-installer":
      return cmdCreateInstaller(rest, deps);
    case "create-user":
      return cmdCreateUser(rest, deps);
    case "reset-password":
      return cmdResetPassword(rest, deps);
    case "disable-user":
      return cmdDisableUser(rest, deps);
    case "enable-user":
      return cmdEnableUser(rest, deps);
    case "create-org":
      return cmdCreateOrg(rest, deps);
    case "create-site":
      return cmdCreateSite(rest, deps);
    case "assign-device":
      return cmdAssignDevice(rest, deps);
    default:
      deps.out(`unknown command: ${command}`);
      deps.out(USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// The real promptSecret: a TTY-only, echo-off prompt.
// ---------------------------------------------------------------------------

/**
 * Ask a question on the real terminal and read back one line with the
 * keystrokes never echoed -- readline with muted output, per
 * cloud/CLOUD-LOGIN-SPEC.md section E. Refuses (rejects) when stdin is not a
 * TTY: a password piped in from a file or a script is exactly the shell-
 * history/process-list exposure this tool's own argument rule refuses
 * elsewhere, so a non-interactive stdin gets the same refusal here.
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
export function promptSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          "promptSecret: stdin is not a TTY -- run this tool interactively so a password is never read from a pipe, a file, or a script",
        ),
      );
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // The documented workaround for a hidden prompt in Node's own readline:
    // intercept the interface's writes to its output and drop them while
    // the secret is being typed, so nothing the user types is ever echoed.
    // Best effort: if a future Node version removes this internal, prompting
    // still works, just without the muting.
    const realWrite = typeof rl._writeToOutput === "function" ? rl._writeToOutput.bind(rl) : null;
    let muted = false;
    if (realWrite !== null) {
      rl._writeToOutput = (chunk) => {
        if (!muted) realWrite(chunk);
      };
    }

    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

// ---------------------------------------------------------------------------
// CLI entry point -- not wired to a real store yet (the AWS spec's job).
// ---------------------------------------------------------------------------

async function main() {
  console.error("no production store yet: the DynamoDB connection comes with the AWS deploy");
  process.exitCode = 1;
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
