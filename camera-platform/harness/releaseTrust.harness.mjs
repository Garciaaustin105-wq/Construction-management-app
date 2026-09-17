/**
 * Whether an appliance installs what it was handed (contracts/releaseTrust.ts).
 *
 * The failures feared here are the ones that look like a successful update:
 * an extra file riding in beside signed ones, a file swapped under a manifest
 * nobody re-read, a correctly signed OLD release replayed to put a fixed hole
 * back, a revoked key still being honoured, and a manifest path that writes
 * outside the install directory with a perfectly valid signature over it.
 */
import { parseManifest, decideUpgrade, isSafeReleasePath } from "../dist/releaseTrust.js";
import { check, eq, report } from "./_assert.mjs";

console.log("releaseTrust");

const COMMIT = "1cabe624460ebc8a510e5c70d35bd297df34d970";
const OLDER = "a".repeat(40);
const hash = (n) => String(n).repeat(64).slice(0, 64);
const file = (path, sha256, bytes = 10) => ({ path, sha256, bytes });

const manifest = (over = {}) => ({
  version: COMMIT,
  builtAtUtc: "2026-09-17T18:00:00.000Z",
  files: [file("VERSION", hash(1)), file("agent/api-server.mjs", hash(2))],
  ...over,
});
const measuredOf = (m) => m.files.map((f) => ({ path: f.path, sha256: f.sha256 }));
const ask = (over = {}) => {
  const m = over.manifest ?? manifest();
  return {
    manifest: m,
    signedBy: "camplat-2026",
    trustedKeyIds: ["camplat-2026"],
    installed: { version: OLDER, builtAtUtc: "2026-09-01T00:00:00.000Z" },
    measured: measuredOf(m),
    ...over,
  };
};

/* ── the manifest ─────────────────────────────────────────────────────────── */

check("a good manifest reads back exactly what it promised", () => {
  const parsed = parseManifest(JSON.stringify(manifest()));
  eq(parsed.ok, true, "accepted");
  eq(parsed.manifest.version, COMMIT, "version");
  eq(parsed.manifest.files.length, 2, "both files");
  eq(parsed.manifest.files[0], { path: "VERSION", sha256: hash(1), bytes: 10 }, "keys in order");
});

check("THE FEARED ONE: a manifest path may not reach outside the install", () => {
  // A signature over this manifest would be perfectly valid, and installing it
  // would write a cron job.
  for (const bad of ["../../etc/cron.d/x", "/etc/passwd", "a/../../b", "./x", "a//b",
    "C:/windows/x", "a\\b", "a\u0000b", "", ".."]) {
    eq(isSafeReleasePath(bad), false, JSON.stringify(bad));
  }
  for (const good of ["VERSION", "agent/api-server.mjs", "dist/a/b/c.js", "setup/install.sh"]) {
    eq(isSafeReleasePath(good), true, good);
  }
  eq(parseManifest(JSON.stringify(manifest({ files: [file("../x", hash(1))] }))).ok, false, "refused by the parser too");
});

check("THE FEARED ONE: one path listed twice is refused, not deduped", () => {
  // One entry gets checked and the other gets installed, and nobody sees which.
  const twice = manifest({ files: [file("agent/x.mjs", hash(1)), file("agent/x.mjs", hash(2))] });
  const parsed = parseManifest(JSON.stringify(twice));
  eq(parsed.ok, false, "refused");
  eq(parsed.reason.includes("twice"), true, parsed.reason);
});

check("manifests that are not manifests are refused as values, never thrown on", () => {
  for (const [what, text] of [
    ["not text", 7], ["not JSON", "{"], ["an array", "[]"], ["null", "null"],
    ["no version", JSON.stringify(manifest({ version: undefined }))],
    ["a version that is not a commit", JSON.stringify(manifest({ version: "v1.2.3" }))],
    ["no build time", JSON.stringify(manifest({ builtAtUtc: undefined }))],
    ["a build time that does not parse", JSON.stringify(manifest({ builtAtUtc: "soon" }))],
    ["no files", JSON.stringify(manifest({ files: [] }))],
    ["files as an object", JSON.stringify(manifest({ files: {} }))],
    ["a file that is not an object", JSON.stringify(manifest({ files: ["VERSION"] }))],
    ["a short hash", JSON.stringify(manifest({ files: [file("VERSION", "abc")] }))],
    ["an upper-case hash", JSON.stringify(manifest({ files: [file("VERSION", "A".repeat(64))] }))],
    ["no byte count", JSON.stringify(manifest({ files: [{ path: "VERSION", sha256: hash(1) }] }))],
    ["negative bytes", JSON.stringify(manifest({ files: [file("VERSION", hash(1), -1)] }))],
  ]) {
    const parsed = parseManifest(text);
    eq(parsed.ok, false, what);
    eq(typeof parsed.reason, "string", what + ": says why");
  }
});

/* ── the decision ─────────────────────────────────────────────────────────── */

check("a signed release whose files match is installed", () => {
  eq(decideUpgrade(ask()), { kind: "install", version: COMMIT }, "installed");
});

check("THE FEARED ONE: nothing unsigned is installed, whatever else is right", () => {
  eq(decideUpgrade(ask({ signedBy: null })).code, "unsigned", "no signature");
  eq(decideUpgrade(ask({ signedBy: undefined })).code, "unsigned", "none at all");
  // The signature is checked before the contents, so a refusal teaches an
  // attacker nothing about what we would have accepted.
  const broken = manifest({ files: [file("gone.mjs", hash(3))] });
  eq(decideUpgrade({ ...ask({ manifest: broken }), signedBy: null, measured: [] }).code,
    "unsigned", "and it is the FIRST thing checked");
});

check("THE FEARED ONE: a revoked key is still a valid signature, and still refused", () => {
  const d = decideUpgrade(ask({ signedBy: "camplat-2025", trustedKeyIds: ["camplat-2026"] }));
  eq(d.code, "untrusted_key", "refused");
  eq(d.message.includes("camplat-2025"), true, "names the key so it can be traced");
  eq(decideUpgrade(ask({ trustedKeyIds: ["camplat-2025", "camplat-2026"] })).kind, "install",
    "and rotation is just two trusted keys at once");
});

check("THE FEARED ONE: a file the manifest never mentioned is refused", () => {
  // A signature over a manifest proves nothing about a file it does not list.
  // This is where a second payload rides in beside honestly signed ones.
  const m = manifest();
  const d = decideUpgrade(ask({
    manifest: m,
    measured: [...measuredOf(m), { path: "agent/.hidden.mjs", sha256: hash(9) }],
  }));
  eq(d.code, "file_extra", "refused");
  eq(d.message.includes("agent/.hidden.mjs"), true, "and names it");
});

check("a file swapped under the manifest, or missing from it, is refused", () => {
  const m = manifest();
  eq(decideUpgrade(ask({
    manifest: m,
    measured: [{ path: "VERSION", sha256: hash(1) }, { path: "agent/api-server.mjs", sha256: hash(7) }],
  })).code, "file_changed", "swapped");
  eq(decideUpgrade(ask({ manifest: m, measured: [{ path: "VERSION", sha256: hash(1) }] })).code,
    "file_missing", "missing");
});

check("THE FEARED ONE: a correctly signed OLD release cannot be replayed", () => {
  // Signatures do not expire, so without this an attacker reinstalls last
  // month's build to put back the hole that was fixed this month.
  const old = manifest({ builtAtUtc: "2026-08-01T00:00:00.000Z" });
  const d = decideUpgrade(ask({ manifest: old, measured: measuredOf(old) }));
  eq(d.code, "downgrade", "refused");
  eq(d.message.includes("2026-08-01"), true, "says which way time went");
  eq(decideUpgrade(ask({ manifest: old, measured: measuredOf(old), allowDowngrade: true })).kind, "install",
    "unless a human says to go back");
});

check("reinstalling the build already on the box is allowed: it repairs a bad file", () => {
  const same = manifest({ builtAtUtc: "2026-09-01T00:00:00.000Z" });
  eq(decideUpgrade(ask({ manifest: same, measured: measuredOf(same) })).kind, "install", "same build time");
});

check("the first install has nothing to be older than", () => {
  const old = manifest({ builtAtUtc: "2020-01-01T00:00:00.000Z" });
  eq(decideUpgrade(ask({ manifest: old, measured: measuredOf(old), installed: null })).kind, "install", "installed");
});

check("a build from an uncommitted tree does not reach a site by accident", () => {
  const dirty = manifest({ version: COMMIT + "-dirty" });
  const d = decideUpgrade(ask({ manifest: dirty, measured: measuredOf(dirty) }));
  eq(d.code, "dirty_release", "refused");
  eq(decideUpgrade(ask({ manifest: dirty, measured: measuredOf(dirty), allowDirty: true })).kind, "install",
    "but the bench can still say yes on purpose");
});

check("an unreadable build time is refused, never treated as newer", () => {
  const d = decideUpgrade({ ...ask(), installed: { version: OLDER, builtAtUtc: "whenever" } });
  eq(d.code, "build_time_unreadable", "refused rather than guessed");
});

report("releaseTrust");
