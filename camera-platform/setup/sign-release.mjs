#!/usr/bin/env node
// Sign a release's MANIFEST.json, so an appliance will install it.
//
//   node setup/sign-release.mjs release/camplat-<sha>.tar.gz
//
// The key comes from CAMPLAT_SIGNING_KEY (a path to an Ed25519 private key in
// PEM) and its name from CAMPLAT_SIGNING_KEY_ID. Nothing here creates a key:
// a key that can push code to every recorder is the most valuable secret in
// the business, and where it lives is a decision, not a default. This script
// is deliberately the only place that touches it, so moving it to a hardware
// token or a KMS later means rewriting this file and nothing else -- the
// appliance's verification does not change.
//
// It reads the tarball, signs the manifest bytes exactly as they are, and
// writes the signature back into the tarball as MANIFEST.sig.

import { execFileSync } from "node:child_process";
import { createPrivateKey, sign as signBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SIGNATURE_NAME = "MANIFEST.sig";
export const MANIFEST_NAME = "MANIFEST.json";

/**
 * The signature envelope written beside the manifest. The key id is here so
 * the appliance knows which trusted key to check against; it is a hint, never
 * a grant -- an appliance that does not already trust that id refuses.
 * @returns {string} the file's contents
 */
export function signManifest(manifestBytes, privateKeyPem, keyId) {
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new Error("a signature needs a key id: set CAMPLAT_SIGNING_KEY_ID");
  }
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`the signing key is ${key.asymmetricKeyType}, not ed25519`);
  }
  // Ed25519 signs the message itself; there is no separate digest to choose,
  // and passing one is an error rather than a preference.
  const signature = signBytes(null, manifestBytes, key);
  return JSON.stringify({ keyId, algorithm: "ed25519", signature: signature.toString("base64") }, null, 2) + "\n";
}

/** @returns {number} the process exit code */
export function main(argv) {
  const tarball = argv[0];
  if (!tarball) {
    console.error("usage: node setup/sign-release.mjs <release.tar.gz>");
    return 1;
  }
  const keyPath = process.env.CAMPLAT_SIGNING_KEY;
  const keyId = process.env.CAMPLAT_SIGNING_KEY_ID;
  if (!keyPath) {
    console.error("CAMPLAT_SIGNING_KEY is not set: it is the path to the Ed25519 private key in PEM");
    return 1;
  }
  if (!keyId) {
    console.error("CAMPLAT_SIGNING_KEY_ID is not set: it names the key, and appliances trust it by name");
    return 1;
  }
  const work = mkdtempSync(path.join(tmpdir(), "camplat-sign-"));
  try {
    execFileSync("tar", ["-xzf", path.resolve(tarball), "-C", work], { stdio: ["ignore", "inherit", "inherit"] });
    const manifestPath = path.join(work, MANIFEST_NAME);
    let manifestBytes;
    try {
      manifestBytes = readFileSync(manifestPath);
    } catch {
      console.error(`${tarball} has no ${MANIFEST_NAME}: it was built before releases were signed`);
      return 1;
    }
    const envelope = signManifest(manifestBytes, readFileSync(keyPath, "utf8"), keyId);
    writeFileSync(path.join(work, SIGNATURE_NAME), envelope);
    execFileSync("tar", ["-czf", path.resolve(tarball), "-C", work, "."], { stdio: ["ignore", "inherit", "inherit"] });
    const { version } = JSON.parse(manifestBytes.toString("utf8"));
    console.log(`${tarball} signed as ${keyId} (VERSION ${version})`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("sign-release.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
