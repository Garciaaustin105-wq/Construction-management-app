/**
 * Whether an appliance should install a release it has been handed.
 *
 * THE FEARED FAILURE: one bad update reaches every site at once. An NVR that
 * installs whatever arrives is a fleet-wide remote code execution waiting for
 * somebody to find the update path -- and unlike a stolen recorder, it does not
 * announce itself. Retrofitting this across a deployed estate means touching
 * every box by hand, so it belongs in the image before the estate exists.
 *
 * Trust here is decided from four separate things, and all four must agree:
 *
 * 1. **A signature this box trusts.** The caller verifies the bytes with a real
 *    Ed25519 check and passes in WHICH key verified, or null. This module never
 *    sees a key or a signature: it is pure, and the cryptography belongs where
 *    node:crypto lives. Passing `signedBy` for a signature that did not verify
 *    is the one lie this module cannot catch, so that call site is the thing to
 *    review.
 * 2. **A manifest that lists every file, with its hash.** A signature over a
 *    manifest proves nothing about a file the manifest does not mention, so an
 *    unlisted file in the tree is refused rather than ignored: that is exactly
 *    where a second payload would ride in.
 * 3. **The tree matching the manifest.** Every listed file present, every hash
 *    equal, nothing extra.
 * 4. **Time moving forward.** A correctly signed OLD release is still a valid
 *    signed release. Replaying one to reintroduce a fixed hole is the attack
 *    that signatures alone do not stop, so a build older than the installed one
 *    is refused unless a human says otherwise.
 *
 * Everything is reported as a decision with a reason. Nothing here installs
 * anything, and a refusal never says "probably fine".
 */

/** One file in a release, as the manifest promises it. */
export interface ManifestFile {
  /** Relative, forward slashes, no leading slash, no "." or ".." segment. */
  path: string;
  /** Lowercase hex, 64 characters. */
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  /** The commit the release was built from, as setup/release.mjs writes it. */
  version: string;
  /** When it was built. A commit id does not order releases; this does. */
  builtAtUtc: string;
  files: ManifestFile[];
}

export type ManifestParse =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A version is a git commit, optionally marked as built from a dirty tree. */
const VERSION = /^[0-9a-f]{40}(-dirty)?$/;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * A path is safe to write under the install directory. Refuses absolute paths,
 * Windows drive letters, backslashes, and any "." or ".." segment -- a manifest
 * entry of "../../etc/cron.d/x" is a signed release writing outside its own
 * directory, and the signature would be perfectly valid.
 */
export function isSafeReleasePath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const parts = p.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

/**
 * Read a manifest. Refuses rather than repairs: a manifest that is not exactly
 * what it should be is not a manifest, because every later check trusts it.
 */
export function parseManifest(text: unknown): ManifestParse {
  if (typeof text !== "string") return { ok: false, reason: "the manifest is not text" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the manifest is not valid JSON" };
  }
  if (!isObject(body)) return { ok: false, reason: "the manifest is not an object" };
  const version = body.version;
  if (typeof version !== "string" || !VERSION.test(version)) {
    return { ok: false, reason: "the manifest has no version naming a commit" };
  }
  const builtAtUtc = body.builtAtUtc;
  if (typeof builtAtUtc !== "string" || Number.isNaN(Date.parse(builtAtUtc))) {
    return { ok: false, reason: "the manifest has no build time that parses" };
  }
  const rawFiles = body.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return { ok: false, reason: "the manifest lists no files" };
  }
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (!isObject(raw)) return { ok: false, reason: "a file entry is not an object" };
    const p = raw.path;
    if (!isSafeReleasePath(p)) {
      return { ok: false, reason: `a file entry has an unsafe path: ${JSON.stringify(p)}` };
    }
    const path = p as string;
    // Two entries for one path means one of them was checked and the other
    // installed, and nobody would see which.
    if (seen.has(path)) return { ok: false, reason: `the manifest lists ${path} twice` };
    seen.add(path);
    const sha256 = raw.sha256;
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      return { ok: false, reason: `${path} has no sha256` };
    }
    const bytes = raw.bytes;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) {
      return { ok: false, reason: `${path} has no byte count` };
    }
    files.push({ path, sha256, bytes: bytes as number });
  }
  return { ok: true, manifest: { version, builtAtUtc, files } };
}

/** What is installed now. `null` before the first install. */
export interface InstalledRelease {
  version: string;
  builtAtUtc: string;
}

export interface UpgradeQuestion {
  manifest: ReleaseManifest;
  /**
   * Which trusted key's signature verified over the manifest bytes, or null if
   * none did. The caller does the cryptography; this module does the policy.
   */
  signedBy: string | null;
  /** Key ids this appliance trusts today. Rotation is a change to this list. */
  trustedKeyIds: readonly string[];
  installed: InstalledRelease | null;
  /** What is actually in the unpacked tree, hashed. */
  measured: readonly { path: string; sha256: string }[];
  /** A human deliberately going back. Off unless somebody says so. */
  allowDowngrade?: boolean;
  /** A human deliberately installing a build from an uncommitted tree. */
  allowDirty?: boolean;
}

export type UpgradeDecision =
  | { kind: "install"; version: string }
  | { kind: "refuse"; code: UpgradeRefusal; message: string };

export type UpgradeRefusal =
  | "unsigned"
  | "untrusted_key"
  | "dirty_release"
  | "file_missing"
  | "file_changed"
  | "file_extra"
  | "downgrade"
  | "build_time_unreadable";

function refuse(code: UpgradeRefusal, message: string): UpgradeDecision {
  return { kind: "refuse", code, message };
}

/**
 * Decide, in this order, first failure winning. The order is deliberate:
 * a release nobody signed is refused before its contents are even discussed,
 * so an attacker learns nothing from the answer about what we would accept.
 */
export function decideUpgrade(q: UpgradeQuestion): UpgradeDecision {
  if (q.signedBy === null || q.signedBy === undefined) {
    return refuse("unsigned", "this release carries no signature from a key this recorder trusts");
  }
  if (!q.trustedKeyIds.includes(q.signedBy)) {
    // A key that once signed releases and has since been revoked lands here.
    return refuse("untrusted_key", `the signing key ${q.signedBy} is not trusted by this recorder`);
  }
  if (q.manifest.version.endsWith("-dirty") && q.allowDirty !== true) {
    return refuse("dirty_release", "this release was built from an uncommitted tree, so no commit describes what is in it");
  }

  const measuredBy = new Map<string, string>();
  for (const m of q.measured) measuredBy.set(m.path, m.sha256);

  for (const f of q.manifest.files) {
    const got = measuredBy.get(f.path);
    if (got === undefined) {
      return refuse("file_missing", `${f.path} is in the manifest but not in the release`);
    }
    if (got !== f.sha256) {
      return refuse("file_changed", `${f.path} is not the file the manifest signed for`);
    }
  }
  // A signature over a manifest says nothing about a file the manifest never
  // mentioned. This is where a second payload would ride in.
  const listed = new Set(q.manifest.files.map((f) => f.path));
  for (const m of q.measured) {
    if (!listed.has(m.path)) {
      return refuse("file_extra", `${m.path} is in the release but not in the manifest`);
    }
  }

  if (q.installed !== null) {
    const now = Date.parse(q.manifest.builtAtUtc);
    const then = Date.parse(q.installed.builtAtUtc);
    if (Number.isNaN(now) || Number.isNaN(then)) {
      return refuse("build_time_unreadable", "a build time does not parse, so this cannot be shown to be newer");
    }
    // Equal is allowed: reinstalling what is already there repairs a bad file.
    if (now < then && q.allowDowngrade !== true) {
      return refuse("downgrade",
        `this release was built ${q.manifest.builtAtUtc}, older than the installed ${q.installed.builtAtUtc}`);
    }
  }

  return { kind: "install", version: q.manifest.version };
}
