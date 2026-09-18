/**
 * The signing path, run for real: a release is built, signed with a key made
 * here and thrown away, and verified the way an appliance verifies it.
 *
 * The keys in this file are generated at run time and never written anywhere
 * that outlives the test. No real signing key exists in this repository.
 *
 * The failures feared: a file swapped after signing, a second file riding in
 * beside signed ones, a signature from a key this box does not trust, a
 * signature that is simply wrong being accepted because the envelope said the
 * right key id, and -- the one that would make the whole exercise theatre -- a
 * forged release bringing its own trusted-keys file along and verifying
 * perfectly against itself.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashTree as releaseHashTree, writeManifest, MANIFEST_NAME, SIGNATURE_NAME } from "../setup/release.mjs";
import { signManifest } from "../setup/sign-release.mjs";
import { main as verify, whoSigned, readTrustedKeys } from "../agent/verify-release.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("releaseVerify");

const root = await mkdtemp(join(tmpdir(), "camplat-verify-"));

const pair = (id) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};
const real = pair("camplat-test");
const attacker = pair("camplat-attacker");

/** A tiny release tree, manifested, and signed with `key` unless told not to. */
async function makeRelease(name, { key = real, files = null, builtAtUtc = "2026-09-17T18:00:00.000Z" } = {}) {
  const dir = join(root, name);
  await mkdir(join(dir, "agent"), { recursive: true });
  const content = files ?? { "VERSION": "abc\n", "agent/api-server.mjs": "// the recorder\n" };
  for (const [rel, text] of Object.entries(content)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  writeManifest(dir, "1cabe624460ebc8a510e5c70d35bd297df34d970", builtAtUtc);
  if (key !== null) {
    const bytes = await readFile(join(dir, MANIFEST_NAME));
    await writeFile(join(dir, SIGNATURE_NAME), signManifest(bytes, key.privateKeyPem, key.id));
  }
  return dir;
}

/** The trust anchor, written OUTSIDE every release tree. */
async function trustFile(name, keys) {
  const file = join(root, name + ".json");
  await writeFile(file, JSON.stringify({ keys: keys.map((k) => ({ id: k.id, publicKeyPem: k.publicKeyPem })) }));
  return file;
}
const trusted = await trustFile("trusted", [real]);

/** Run the verifier as upgrade.sh runs it. */
function run(dir, { keysFile = trusted, argv = [] } = {}) {
  process.env.CAMPLAT_TRUSTED_KEYS = keysFile;
  return verify([dir, ...argv]);
}

await check("a release built, signed and verified the way it will be in the field", async () => {
  const dir = await makeRelease("good");
  eq(run(dir), 0, "installs");
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST_NAME), "utf8"));
  eq(manifest.files.map((f) => f.path), ["VERSION", "agent/api-server.mjs"], "every shipped file listed, sorted");
  eq(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), true, "each with a hash");
  eq(releaseHashTree(dir).length, 2, "and the manifest does not list itself or its signature");
});

await check("THE FEARED ONE: a file swapped after signing is refused", async () => {
  const dir = await makeRelease("swapped");
  await writeFile(join(dir, "agent/api-server.mjs"), "// something else entirely\n");
  eq(run(dir), 1, "refused");
});

await check("THE FEARED ONE: a second file riding in beside signed ones is refused", async () => {
  const dir = await makeRelease("extra");
  await writeFile(join(dir, "agent/.backdoor.mjs"), "// hello\n");
  eq(run(dir), 1, "refused");
});

await check("THE FEARED ONE: a forged release cannot bring its own trusted keys", async () => {
  // If the anchor shipped inside the tarball this would verify perfectly
  // against itself: a real signature, by a real key, proving nothing at all.
  const dir = await makeRelease("byo-keys", { key: attacker });
  await writeFile(join(dir, "trusted-keys.json"),
    JSON.stringify({ keys: [{ id: attacker.id, publicKeyPem: attacker.publicKeyPem }] }));
  eq(run(dir), 1, "refused: the box reads its own anchor, not the release's");
  // And the file it smuggled in is itself an unlisted file, caught twice over.
  eq(run(dir, { keysFile: await trustFile("both", [real, attacker]) }), 1, "still refused as an extra file");
});

await check("a signature from a key this recorder does not trust is refused", async () => {
  const dir = await makeRelease("wrong-key", { key: attacker });
  eq(run(dir), 1, "refused");
  eq(run(dir, { keysFile: await trustFile("attacker", [attacker]) }), 0,
    "and the same release installs where that key IS trusted, so it is the trust that decided");
});

await check("naming a trusted key does not make a signature valid", async () => {
  // The envelope is the attacker's signature relabelled as the real key id.
  const dir = await makeRelease("relabelled", { key: attacker });
  const envelope = JSON.parse(await readFile(join(dir, SIGNATURE_NAME), "utf8"));
  envelope.keyId = real.id;
  await writeFile(join(dir, SIGNATURE_NAME), JSON.stringify(envelope));
  eq(run(dir), 1, "refused");
  const bytes = await readFile(join(dir, MANIFEST_NAME));
  eq(whoSigned(bytes, JSON.stringify(envelope), { [real.id]: real.publicKeyPem }), null, "and nobody signed it");
});

await check("an unsigned release, and a signature that is not one, are refused", async () => {
  eq(run(await makeRelease("unsigned", { key: null })), 1, "no signature at all");
  const dir = await makeRelease("corrupt");
  await writeFile(join(dir, SIGNATURE_NAME), "not json");
  eq(run(dir), 1, "not a signature");
  const dir2 = await makeRelease("truncated");
  const env = JSON.parse(await readFile(join(dir2, SIGNATURE_NAME), "utf8"));
  env.signature = env.signature.slice(0, 20);
  await writeFile(join(dir2, SIGNATURE_NAME), JSON.stringify(env));
  eq(run(dir2), 1, "a signature that does not verify");
});

await check("a recorder with no trust anchor installs nothing, rather than anything", async () => {
  const dir = await makeRelease("anchorless");
  eq(run(dir, { keysFile: join(root, "does-not-exist.json") }), 1, "missing file");
  eq(run(dir, { keysFile: await trustFile("empty", []) }), 1, "a file with no keys");
  eq(readTrustedKeys(join(root, "does-not-exist.json")), {}, "an unreadable anchor is an empty set");
});

await check("a revoked key stops signing releases without anybody reissuing the others", async () => {
  const dir = await makeRelease("revoked");
  const file = join(root, "revoked.json");
  await writeFile(file, JSON.stringify({ keys: [{ id: real.id, publicKeyPem: real.publicKeyPem, revoked: true }] }));
  eq(run(dir, { keysFile: file }), 1, "refused");
  eq(Object.keys(readTrustedKeys(file)), [], "a revoked key is simply not trusted");
});

await check("a release older than the installed one is refused unless somebody says otherwise", async () => {
  const installed = await makeRelease("installed-now", { builtAtUtc: "2026-09-17T18:00:00.000Z" });
  const older = await makeRelease("older", { builtAtUtc: "2026-08-01T00:00:00.000Z" });
  eq(run(older, { argv: ["--installed", installed] }), 1, "replaying last month is refused");
  eq(run(older, { argv: ["--installed", installed, "--allow-downgrade"] }), 0, "unless a human goes back on purpose");
  eq(run(older), 0, "and a first install has nothing to be older than");
});

await rm(root, { recursive: true, force: true });
report("releaseVerify");
