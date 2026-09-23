/**
 * setup/harden-proc.sh and setup/verify-hidepid.sh, run for real under bash
 * against throwaway fstab files -- never a real /etc/fstab, never a real
 * /proc remount (build rule 21: a harness never touches real data unscoped).
 *
 * The failure feared: a script that is supposed to make an appliance SAFER
 * corrupts a stranger's fstab, silently widens who can see every process's
 * command line instead of narrowing it, or the box it runs on never boots
 * again because a bad fstab line does not remount cleanly. Every check below
 * is aimed at one of those, not at the happy path alone.
 *
 * Not run: the group/user step (getent/groupadd/usermod) and the real
 * remount -- both require actual root and a real Linux box, and both are
 * gated in the script itself to skip on a scoped, non-root --fstab run,
 * which is exactly what these checks are; their ORDER is checked statically
 * instead. verify-hidepid.sh needs a running appliance, so only its mount-
 * options judgment runs for real (sourced, which defines and touches nothing);
 * the rest gets a static text check (no command-line or environment reads).
 */
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, eq, report } from "./_assert.mjs";

console.log("hardenProc");

function bashAvailable() {
  const r = spawnSync("bash", ["--version"]);
  return !r.error && r.status === 0;
}

if (!bashAvailable()) {
  console.log("SKIP: no bash on PATH -- cannot run setup/*.sh under bash here");
  process.exit(0);
}

// The checkout can be CRLF on Windows (core.autocrlf=true); .gitattributes
// now forces setup/*.sh to LF, but a working tree checked out before that
// fix can still be CRLF, and bash will not run a CRLF script (same issue
// harness/trustAnchor.harness.mjs works around, for the same reason).
async function loadLF(relPath) {
  const raw = await readFile(new URL(`../${relPath}`, import.meta.url), "utf8");
  return raw.replace(/\r\n/g, "\n");
}

const root = await mkdtemp(join(tmpdir(), "camplat-hardenproc-"));
const scriptRel = {
  harden: "setup/harden-proc.sh",
  verify: "setup/verify-hidepid.sh",
  install: "setup/install.sh",
  upgrade: "setup/upgrade.sh",
};
const staged = {};
const rawText = {};
for (const [key, rel] of Object.entries(scriptRel)) {
  const lf = await loadLF(rel);
  rawText[key] = lf;
  const dest = join(root, `${key}.sh`);
  await writeFile(dest, lf);
  staged[key] = dest;
}

await check("all four touched scripts pass bash -n", () => {
  for (const [key, dest] of Object.entries(staged)) {
    const r = spawnSync("bash", ["-n", dest], { encoding: "utf8" });
    eq(r.status, 0, `${key}: bash -n (${r.stderr || ""})`);
  }
});

await check("install.sh runs harden-proc.sh for new installs, defaulting ON, behind a named skip", () => {
  eq(/CAMPLAT_HARDEN_PROC/.test(rawText.install), true, "the skip variable is named");
  eq(/harden-proc\.sh/.test(rawText.install), true, "install.sh calls harden-proc.sh");
  eq(/CAMPLAT_HARDEN_PROC:-1/.test(rawText.install), true, "default is ON (unset behaves as 1)");
});

await check("upgrade.sh reloads systemd before restarting, and never runs the hardening", () => {
  const reloadIdx = rawText.upgrade.indexOf("systemctl daemon-reload");
  const restartIdx = rawText.upgrade.indexOf("systemctl restart camplat-recorder");
  eq(reloadIdx > -1, true, "daemon-reload is present");
  eq(restartIdx > -1, true, "the restart is present");
  eq(reloadIdx < restartIdx, true, "daemon-reload runs before the restart");
  eq(/harden-proc\.sh/.test(rawText.upgrade), false, "upgrade.sh never calls harden-proc.sh");
});

await check("verify-hidepid.sh never lists a command line or reads process environment (static)", () => {
  const hay = rawText.verify.toLowerCase();
  for (const bad of ["ps aux", "ps -ef", "pgrep -a", "cmdline", "environ"]) {
    eq(hay.includes(bad), false, `must not contain "${bad}"`);
  }
});

await check("harden-proc.sh only ever adds polkitd to the group -- never the admin login or camplat", () => {
  const addLines = rawText.harden.split("\n").filter((l) => /usermod\s+-aG/.test(l));
  eq(addLines.length, 1, `exactly one usermod -aG line (found ${addLines.length})`);
  eq(/"\$REQUIRED_USER"/.test(addLines[0]), true, "it targets $REQUIRED_USER");
  eq(/camplat|RUN_USER|admin/.test(addLines[0]), false, "it never names camplat or an admin login");
  eq(/^REQUIRED_USER="polkitd"$/m.test(rawText.harden), true, "REQUIRED_USER is polkitd, not configurable by a flag");
});

await check("ORDER: the group exists before fstab or the live mount names it", () => {
  // Found in review 2026-09-23, before it ever ran on a box: the remount ran
  // first, and mount cannot turn gid=proc into a number for a group that does
  // not exist yet -- so the first run would fail the remount and leave an fstab
  // line that could not apply at boot either.
  const text = rawText.harden;
  const groupadd = text.indexOf('groupadd --system "$GROUP"');
  const fstabWrite = text.indexOf('mv "$TMP" "$FSTAB"');
  const remount = text.indexOf('mount -o "remount,${NEW_OPTS}" /proc');
  eq(groupadd > -1 && fstabWrite > -1 && remount > -1, true, "all three steps are present");
  eq(groupadd < fstabWrite, true, "groupadd comes before the fstab write");
  eq(groupadd < remount, true, "groupadd comes before the remount");
  eq(text.indexOf("usermod -aG") < fstabWrite, true, "polkitd joins the group before the fstab write too");
});

/** Source verify-hidepid.sh (defines its functions, runs nothing) and judge one mount. */
function judge(opts, gid) {
  const r = spawnSync("bash", ["-c", 'source "$1" && judge_proc_opts "$2" "$3"', "_", staged.verify.replace(/\\/g, "/"), opts, gid], { encoding: "utf8" });
  if (r.error) throw new Error(`bash could not be started: ${r.error.message}`);
  return (r.stdout || "").trim() || `(no output; stderr: ${r.stderr})`;
}

await check("verify judges the mount by the group's NUMBER, the way the kernel reports it", () => {
  // Found in review 2026-09-23: the checker looked for gid=proc, the kernel
  // prints gid=997, so a correctly hardened box would always have read FAIL.
  const base = "rw,nosuid,nodev,noexec,relatime";
  eq(judge(`${base},hidepid=invisible,gid=997`, "997"), "ok", "hardened box, numeric gid: ok");
  eq(judge(`${base},gid=997,hidepid=2`, "997"), "ok", "a pre-5.8 kernel prints hidepid=2: ok");
  eq(judge(`${base},hidepid=invisible,gid=9970`, "997").startsWith("hidepid is active, but not with gid=997"), true, "gid=9970 is not gid=997 (whole options, not substrings)");
  eq(judge(`${base},hidepid=invisible`, "").includes("no 'proc' group"), true, "no group on the box: says so");
  eq(judge(`${base},hidepid=invisible`, "997").startsWith("hidepid is active, but not with gid=997"), true, "hidepid with no gid (the temporary test mount): not ok");
  eq(judge(`${base},hidepid=invisibleX,gid=997`, "997").startsWith("hidepid=invisible not active"), true, "a look-alike option is not hidepid");
  eq(judge(base, "997").startsWith("hidepid=invisible not active"), true, "not hardened at all: not ok");
  eq(judge("", "997"), "could not read /proc's mount options at all", "unreadable: not ok");
});

/** Run harden-proc.sh against a scoped fixture; never touches a real fstab. */
function runHarden(args) {
  const r = spawnSync("bash", [staged.harden, ...args], { encoding: "utf8" });
  if (r.error) throw new Error(`bash could not be started: ${r.error.message}`);
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

async function backupsFor(fixture) {
  const dir = root;
  const base = fixture.split(/[\\/]/).pop();
  const all = await readdir(dir);
  return all.filter((f) => f.startsWith(`${base}.camplat-bak.`));
}

let n = 0;
function nextFixture() {
  return join(root, `fstab-${n++}`);
}

await check("--dry-run against a fixture with no /proc line: prints a plan, changes nothing, needs no root", async () => {
  const fx = nextFixture();
  const before = "# comment\nUUID=abc / ext4 defaults 0 1\n";
  await writeFile(fx, before);
  const r = runHarden(["--dry-run", "--fstab", fx]);
  eq(r.code, 0, `exit code (${r.out})`);
  eq(await readFile(fx, "utf8"), before, "the fixture is untouched");
  eq(r.out.includes("hidepid=invisible"), true, "the plan names the option it would set");
  eq((await backupsFor(fx)).length, 0, "no backup for a dry run");
});

await check("adds exactly one /proc line, backs it up, and keeps every other line byte-for-byte", async () => {
  const fx = nextFixture();
  const before = "# comment line\nUUID=abc-123 / ext4 defaults 0 1\nUUID=def-456 /home ext4 defaults 0 2\n";
  await writeFile(fx, before);
  const r = runHarden(["--fstab", fx, "--no-remount"]);
  eq(r.code, 0, `exit code (${r.out})`);
  const after = await readFile(fx, "utf8");
  const beforeLines = before.trimEnd().split("\n");
  const afterLines = after.trimEnd().split("\n");
  eq(afterLines.length, beforeLines.length + 1, "exactly one line added");
  for (let i = 0; i < beforeLines.length; i++) {
    eq(afterLines[i], beforeLines[i], `line ${i + 1} unchanged`);
  }
  eq(/^proc \/proc proc .*hidepid=invisible.*gid=proc.* 0 0$/.test(afterLines.at(-1)), true, `new line shape: ${afterLines.at(-1)}`);
  const backups = await backupsFor(fx);
  eq(backups.length, 1, "exactly one backup made");
  eq(await readFile(join(root, backups[0]), "utf8"), before, "the backup holds the ORIGINAL content, not the new");
});

await check("a second run is a true no-op: file unchanged, no new backup", async () => {
  const fx = nextFixture();
  const before = "UUID=abc / ext4 defaults 0 1\n";
  await writeFile(fx, before);
  const r1 = runHarden(["--fstab", fx, "--no-remount"]);
  eq(r1.code, 0, "first run ok");
  const afterFirst = await readFile(fx, "utf8");
  const backupsAfterFirst = (await backupsFor(fx)).length;
  const r2 = runHarden(["--fstab", fx, "--no-remount"]);
  eq(r2.code, 0, "second run ok");
  eq(r2.out.includes("already configured"), true, "and says so");
  eq(await readFile(fx, "utf8"), afterFirst, "the file did not change at all");
  eq((await backupsFor(fx)).length, backupsAfterFirst, "no new backup was made");
});

await check("an existing /proc line keeps its OTHER recognised options when hidepid is updated", async () => {
  const fx = nextFixture();
  await writeFile(fx, "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n");
  const r = runHarden(["--fstab", fx, "--no-remount"]);
  eq(r.code, 0, `exit code (${r.out})`);
  const line = (await readFile(fx, "utf8")).trim();
  for (const opt of ["rw", "nosuid", "nodev", "noexec", "relatime"]) {
    eq(line.includes(opt), true, `kept ${opt}`);
  }
  eq(line.includes("hidepid=invisible"), true, "hidepid updated to invisible");
  eq(line.includes("hidepid=2"), false, "the stale numeric hidepid value is gone, not left alongside the new one");
  eq(line.includes("gid=proc"), true, "gid added");
});

await check("MUTATION CHECK: an unrecognised conflicting /proc line is refused, not silently kept or dropped", async () => {
  const fx = nextFixture();
  const before = "proc /proc proc rw,nosuid,nodev,noexec,relatime,mystery=1 0 0\n";
  await writeFile(fx, before);
  const r = runHarden(["--fstab", fx, "--no-remount"]);
  eq(r.code, 1, `refused (${r.out})`);
  eq(r.out.includes("mystery=1"), true, "the unrecognised option is named in the refusal");
  eq(await readFile(fx, "utf8"), before, "the fixture is byte-for-byte untouched");
  eq((await backupsFor(fx)).length, 0, "refusing happens before any backup is made");
});

await check("--undo restores hidepid=off and removes the gid it added", async () => {
  const fx = nextFixture();
  await writeFile(fx, "UUID=abc / ext4 defaults 0 1\n");
  const forward = runHarden(["--fstab", fx, "--no-remount"]);
  eq(forward.code, 0, `forward run ok (${forward.out})`);
  const undo = runHarden(["--fstab", fx, "--no-remount", "--undo"]);
  eq(undo.code, 0, `undo ok (${undo.out})`);
  const lines = (await readFile(fx, "utf8")).trimEnd().split("\n");
  const procLine = lines.find((l) => l.startsWith("proc /proc"));
  eq(procLine.includes("hidepid=off"), true, `hidepid restored to off: ${procLine}`);
  eq(procLine.includes("gid=proc"), false, "the gid this script added is removed with it");
  eq(undo.out.toLowerCase().includes("hidepid restored to off") || undo.out.toLowerCase().includes("restored"), true, "says what it did");
});

await check("a second --undo is a no-op and says there is nothing to undo", async () => {
  const fx = nextFixture();
  await writeFile(fx, "UUID=abc / ext4 defaults 0 1\n");
  runHarden(["--fstab", fx, "--no-remount"]);
  runHarden(["--fstab", fx, "--no-remount", "--undo"]);
  const afterFirstUndo = await readFile(fx, "utf8");
  const r2 = runHarden(["--fstab", fx, "--no-remount", "--undo"]);
  eq(r2.code, 0, `second undo ok (${r2.out})`);
  eq(r2.out.includes("nothing to undo"), true, "says nothing to undo");
  eq(await readFile(fx, "utf8"), afterFirstUndo, "the file did not change");
});

await check("MUTATION CHECK: not root against the real default fstab path is refused before touching anything", () => {
  // No --fstab at all: this is the LIVE path (real /etc/fstab). This process
  // is never root, so it must refuse -- if it did not, the next line down
  // (the actual write) would be exercised against a real system file.
  const r = spawnSync("bash", [staged.harden], { encoding: "utf8" });
  eq(r.status, 1, `refused (${(r.stdout || "") + (r.stderr || "")})`);
  eq(((r.stdout || "") + (r.stderr || "")).toLowerCase().includes("root"), true, "names root as the problem");
});

await rm(root, { recursive: true, force: true }).catch(() => {});
process.exit(report("hardenProc") === 0 ? 0 : 1);
