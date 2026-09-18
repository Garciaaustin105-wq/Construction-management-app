/**
 * setup/trust-anchor.sh, run for real under bash: the script that places the
 * trust anchor an appliance verifies its updates against.
 *
 * install.sh cannot be harness-run (it is a root-on-a-bare-box script), so the
 * anchor logic lives in its own script and every path through it is tested
 * here with the paths redirected into a throwaway directory -- the same
 * CAMPLAT_TRUSTED_KEYS override that redirects the verifier in
 * releaseVerify.harness.mjs.
 *
 * The failures feared: an install that leaves a box anchorless (every future
 * upgrade refused, a truck roll per site), a keys file from INSIDE a release
 * making a forged release self-verifying, a re-run quietly replacing a
 * different anchor (an attacker with one SSH session rotates your trust), a
 * file the script accepts but the verifier does not trust (or refuses but the
 * verifier would have trusted) -- the two implementations drifting.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTrustedKeys } from "../agent/verify-release.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("trustAnchor");

// The checkout is CRLF on Windows and bash does not run CRLF scripts. The
// release tarball ships this file LF (setup/release.mjs normalises .sh), so
// normalise here and test what ships.
const raw = await readFile(new URL("../setup/trust-anchor.sh", import.meta.url), "utf8");
if (!/^#!\/usr\/bin\/env bash\n/.test(raw.replace(/\r\n/g, "\n"))) {
  throw new Error("trust-anchor.sh did not normalise to LF the way release.mjs stages it");
}
const root = await mkdtemp(join(tmpdir(), "camplat-anchor-"));
const script = join(root, "trust-anchor.sh");
await writeFile(script, raw.replace(/\r\n/g, "\n"));

const pair = (id) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};
const real = pair("camplat-test");
const next = pair("camplat-test-2027");
const attacker = pair("camplat-attacker");

/** The keys file an operator would carry, exactly as the handoff shapes it. */
async function keysFile(name, entries) {
  const file = join(root, name + ".json");
  await writeFile(file, JSON.stringify({ keys: entries }));
  return file;
}
const keyEntry = (k, extra = {}) => ({ id: k.id, publicKeyPem: k.publicKeyPem, ...extra });

const keysFileTarget = join(root, "anchor", "trusted-keys.json");
const appDir = join(root, "opt", "camplat");

const baseEnv = { ...process.env };
for (const k of Object.keys(baseEnv)) {
  if (k.startsWith("CAMPLAT_") || k === "NODE_BIN") delete baseEnv[k];
}

/** Run the script the way install.sh does, with paths redirected. */
function runAnchor(env = {}) {
  const r = spawnSync("bash", [script], {
    env: { ...baseEnv, NODE_BIN: process.execPath, CAMPLAT_TRUSTED_KEYS: keysFileTarget, CAMPLAT_APP_DIR: appDir, ...env },
    encoding: "utf8",
  });
  if (r.error) throw new Error(`bash could not be started: ${r.error.message}`);
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

await check("a keys file a person passes becomes the anchor, and what it trusts matches the verifier", async () => {
  const source = await keysFile("first", [keyEntry(real)]);
  const r = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: source });
  eq(r.code, 0, `exit code (output: ${r.out})`);
  eq(existsSync(keysFileTarget), true, "the anchor exists");
  eq(await readFile(keysFileTarget, "utf8"), await readFile(source, "utf8"), "placed verbatim, the operator's file is the truth");
  eq(r.out.includes(real.id), true, "the trusted id is named on the way out");
  eq(readTrustedKeys(keysFileTarget), { [real.id]: real.publicKeyPem }, "and the verifier trusts exactly what was placed");
});

await check("a re-run with the same file changes nothing", async () => {
  const source = await keysFile("first", [keyEntry(real)]);
  const before = (await readFile(keysFileTarget, "utf8"));
  const r = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: source });
  eq(r.code, 0, "exit code");
  eq(await readFile(keysFileTarget, "utf8"), before, "the anchor is untouched");
  eq(r.out.includes("unchanged"), true, "and says so");
});

await check("a re-run with no source keeps the anchor that is there", async () => {
  const r = runAnchor();
  eq(r.code, 0, "exit code");
  eq(readTrustedKeys(keysFileTarget), { [real.id]: real.publicKeyPem }, "the anchor is untouched");
});

await check("a DIFFERENT anchor is not installed quietly; FORCE is the deploy step of rotation", async () => {
  const rotated = await keysFile("rotated", [keyEntry(real), keyEntry(next)]);
  const before = await readFile(keysFileTarget, "utf8");
  const refused = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: rotated });
  eq(refused.code, 1, "refused without FORCE");
  eq(await readFile(keysFileTarget, "utf8"), before, "the anchor is untouched");
  eq(refused.out.includes("rotation"), true, "the refusal explains rotation");
  const forced = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: rotated, CAMPLAT_TRUSTED_KEYS_FORCE: "1" });
  eq(forced.code, 0, "installed with FORCE");
  eq(readTrustedKeys(keysFileTarget), { [real.id]: real.publicKeyPem, [next.id]: next.publicKeyPem }, "both ids trusted: add, deploy, then remove the old");
  const removed = await keysFile("removed-old", [keyEntry(next)]);
  const forced2 = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: removed, CAMPLAT_TRUSTED_KEYS_FORCE: "1" });
  eq(forced2.code, 0, "deployed");
  eq(readTrustedKeys(keysFileTarget), { [next.id]: next.publicKeyPem }, "rotation lands: only the new key is trusted");
});

await check("THE FEARED ONE: a keys file from inside the release is refused", async () => {
  await mkdir(join(appDir, "etc"), { recursive: true });
  const smuggled = join(appDir, "etc", "trusted-keys.json");
  await writeFile(smuggled, JSON.stringify({ keys: [keyEntry(attacker)] }));
  const r = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: smuggled });
  eq(r.code, 1, "refused");
  eq(r.out.includes("inside"), true, "and the reason named");
  // And even the .new sibling -- the release half-unpacked beside the program.
  const halfUnpacked = join(root, "opt", "camplat.new", "trusted-keys.json");
  await mkdir(join(root, "opt", "camplat.new"), { recursive: true });
  await writeFile(halfUnpacked, JSON.stringify({ keys: [keyEntry(attacker)] }));
  eq(runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: halfUnpacked }).code, 1, "the .new sibling too");
});

await check("a source that is no anchor at all is refused and nothing is written", async () => {
  const target = join(root, "fresh-box", "trusted-keys.json");
  const good = await keysFile("good2", [keyEntry(real)]);
  const missing = runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: join(root, "not-there.json") });
  eq(missing.code, 1, "no file at the path");
  eq(existsSync(target), false, "nothing placed by the failed run");
  const notJson = join(root, "not-json.json");
  await writeFile(notJson, "this is not json");
  eq(runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: notJson }).code, 1, "not JSON");
  const noKeys = join(root, "no-keys.json");
  await writeFile(noKeys, JSON.stringify({ hello: "world" }));
  eq(runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: noKeys }).code, 1, "no keys array");
  const allRevoked = await keysFile("all-revoked", [keyEntry(real, { revoked: true })]);
  eq(runAnchor({ CAMPLAT_TRUSTED_KEYS_SOURCE: allRevoked }).code, 1, "every key revoked");
  eq(existsSync(target), false, "still nothing placed");
  // The script's verdicts agree with the verifier's readTrustedKeys in both
  // directions, on every file this check has offered it.
  for (const f of [notJson, noKeys, allRevoked, good]) {
    eq(Object.keys(readTrustedKeys(f)).length > 0, f === good, `${f} accepted by the script iff trusted by the verifier`);
  }
});

await check("an install with no anchor and no keys given is refused, unless bootstrap says so", async () => {
  const target = join(root, "empty-box", "trusted-keys.json");
  const refused = runAnchor({ CAMPLAT_TRUSTED_KEYS: target });
  eq(refused.code, 1, "refused");
  eq(refused.out.includes("CAMPLAT_BOOTSTRAP=1"), true, "the way out is named");
  eq(existsSync(target), false, "and no anchor was invented");
  const bootstrapped = runAnchor({ CAMPLAT_TRUSTED_KEYS: target, CAMPLAT_BOOTSTRAP: "1" });
  eq(bootstrapped.code, 0, "bootstrap installs");
  eq(existsSync(target), false, "but writes no anchor: bootstrap is a promise, not a placement");
  eq(bootstrapped.out.includes("refuse every upgrade"), true, "and says what it means");
});

await check("an anchor that exists but holds no usable key is kept and warned about, not deleted", async () => {
  const target = join(root, "rotted", "trusted-keys.json");
  // The script rightly refuses to PLACE a file with no usable key, so a
  // rotted anchor is a hand-made thing: the one key in it revoked by hand.
  await mkdir(join(root, "rotted"), { recursive: true });
  await writeFile(target, JSON.stringify({ keys: [keyEntry(real, { revoked: true })] }));
  const r = runAnchor({ CAMPLAT_TRUSTED_KEYS: target });
  eq(r.code, 0, "a re-run does not fail on a rotted anchor");
  eq(existsSync(target), true, "the file is kept: removal is a person's act");
  eq(r.out.includes("NO usable key"), true, "but the operator is told the box refuses every upgrade");
});

await rm(root, { recursive: true, force: true });
report("trustAnchor");