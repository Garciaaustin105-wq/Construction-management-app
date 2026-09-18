#!/usr/bin/env node
// Decide whether an unpacked release may be installed, and say why not.
//
//   node agent/verify-release.mjs <unpacked-dir> [--installed <dir>] [--allow-downgrade] [--allow-dirty]
//
// Exits 0 to install, 1 to refuse. setup/upgrade.sh runs this between
// unpacking and swapping, so a release that fails is never the running one.
//
// THE TRUST ANCHOR LIVES OUTSIDE THE RELEASE. The public keys are read from
// /etc/camplat/trusted-keys.json (CAMPLAT_TRUSTED_KEYS overrides), placed by
// setup/install.sh and owned by root. If they shipped inside the tarball, a
// forged release would simply bring its own trusted keys and verify perfectly
// against itself -- the signature would be real and prove nothing.
//
// This file does the I/O and the cryptography. Every decision it makes comes
// from contracts/releaseTrust.ts, which is pure and harness-tested, so the
// rules can be read in one place and cannot drift into this script.

import { createHash, createPublicKey, verify as verifyBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseManifest, decideUpgrade } from "../dist/releaseTrust.js";

export const MANIFEST_NAME = "MANIFEST.json";
export const SIGNATURE_NAME = "MANIFEST.sig";
const DEFAULT_TRUSTED_KEYS = "/etc/camplat/trusted-keys.json";

/** Every file under `dir`, hashed, the manifest and its signature excluded. */
export function hashTree(dir) {
  const out = [];
  for (const rel of readdirSync(dir, { recursive: true })) {
    const abs = path.join(dir, rel);
    if (statSync(abs).isDirectory()) continue;
    const relPath = String(rel).split(path.sep).join("/");
    if (relPath === MANIFEST_NAME || relPath === SIGNATURE_NAME) continue;
    out.push({ path: relPath, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") });
  }
  return out;
}

/**
 * The trusted keys, as { id: publicKeyPem }. A file that cannot be read, or
 * that holds no keys, is an empty set -- which refuses everything. An appliance
 * with no trust anchor installs nothing, rather than installing anything.
 */
export function readTrustedKeys(file) {
  let body;
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof body !== "object" || body === null || !Array.isArray(body.keys)) return {};
  const keys = {};
  for (const k of body.keys) {
    if (typeof k !== "object" || k === null) continue;
    if (typeof k.id !== "string" || typeof k.publicKeyPem !== "string") continue;
    if (k.revoked === true) continue;
    keys[k.id] = k.publicKeyPem;
  }
  return keys;
}

/**
 * Which trusted key's signature verifies over these manifest bytes, or null.
 * The envelope names a key, but naming one grants nothing: an id that is not
 * in the trusted set is never even tried, and a signature that does not verify
 * returns null however it was labelled.
 */
export function whoSigned(manifestBytes, envelopeText, trustedKeys) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    return null;
  }
  if (typeof envelope !== "object" || envelope === null) return null;
  if (envelope.algorithm !== "ed25519") return null;
  const { keyId, signature } = envelope;
  if (typeof keyId !== "string" || typeof signature !== "string") return null;
  const pem = Object.prototype.hasOwnProperty.call(trustedKeys, keyId) ? trustedKeys[keyId] : undefined;
  if (typeof pem !== "string") return null;
  let ok = false;
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return null;
    ok = verifyBytes(null, manifestBytes, key, Buffer.from(signature, "base64"));
  } catch {
    return null;
  }
  return ok ? keyId : null;
}

/** What is installed now, from the manifest the last install left behind. */
export function installedRelease(appDir) {
  try {
    const parsed = parseManifest(readFileSync(path.join(appDir, MANIFEST_NAME), "utf8"));
    if (parsed.ok !== true) return null;
    return { version: parsed.manifest.version, builtAtUtc: parsed.manifest.builtAtUtc };
  } catch {
    // No manifest means a release from before signing, or a first install.
    // Neither is something to be older than.
    return null;
  }
}

/** @returns {number} the process exit code */
export function main(argv) {
  const dir = argv[0];
  if (!dir) {
    console.error("usage: node agent/verify-release.mjs <unpacked-dir> [--installed <dir>]");
    return 1;
  }
  const installedAt = argv.includes("--installed") ? argv[argv.indexOf("--installed") + 1] : null;
  const keysFile = process.env.CAMPLAT_TRUSTED_KEYS || DEFAULT_TRUSTED_KEYS;
  const trustedKeys = readTrustedKeys(keysFile);
  if (Object.keys(trustedKeys).length === 0) {
    console.error(`REFUSED: no trusted keys in ${keysFile}, so nothing can be shown to be genuine`);
    return 1;
  }

  let manifestBytes;
  try {
    manifestBytes = readFileSync(path.join(dir, MANIFEST_NAME));
  } catch {
    console.error(`REFUSED: this release has no ${MANIFEST_NAME}, so there is nothing to check it against`);
    return 1;
  }
  const parsed = parseManifest(manifestBytes.toString("utf8"));
  if (parsed.ok !== true) {
    console.error(`REFUSED: ${parsed.reason}`);
    return 1;
  }

  let envelopeText = "";
  try {
    envelopeText = readFileSync(path.join(dir, SIGNATURE_NAME), "utf8");
  } catch {
    envelopeText = "";
  }
  const signedBy = envelopeText === "" ? null : whoSigned(manifestBytes, envelopeText, trustedKeys);

  const decision = decideUpgrade({
    manifest: parsed.manifest,
    signedBy,
    trustedKeyIds: Object.keys(trustedKeys),
    installed: installedAt ? installedRelease(installedAt) : null,
    measured: hashTree(dir),
    allowDowngrade: argv.includes("--allow-downgrade"),
    allowDirty: argv.includes("--allow-dirty"),
  });

  if (decision.kind === "install") {
    console.log(`OK: ${decision.version}, signed by ${signedBy}, ${parsed.manifest.files.length} files verified`);
    return 0;
  }
  console.error(`REFUSED (${decision.code}): ${decision.message}`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("verify-release.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
