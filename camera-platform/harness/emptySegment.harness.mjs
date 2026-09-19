/**
 * Segments that hold no video: the stub a restart leaves (FIELD-NOTES
 * 2026-09-18, finding 4: a 28-byte `ftyp` per camera, counted by recovery as
 * `partials: 16` and listed like a real recording).
 *
 * THE FEARED FAILURES: a stub indexed as a recording, so the Review page lists
 * a clip that will not play; deciding by SIZE, so a stub of another size
 * slips through or a small real fragment is thrown out; anything that is not
 * our MP4 called "empty" and moved; recovery leaving an index row that points
 * at a file it just moved.
 */
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasVideoBoxes, INPROGRESS, QUARANTINE } from "../agent/segstore.mjs";
import { runRecovery } from "../agent/recorder-service.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("empty segments");

const box = (type, payload = Buffer.alloc(0)) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, "latin1");
  payload.copy(b, 8);
  return b;
};
const ftyp = (brands) => box("ftyp", Buffer.from("isom" + "\0\0\x02\0" + brands.join(""), "latin1"));
// ffmpeg's own stub: major isom, minor 0x200, compatible isom iso2 mp41.
const stub28 = ftyp(["isom", "iso2", "mp41"]);             // 8 + 8 + 12 = 28 bytes
const stub32 = ftyp(["isom", "iso2", "avc1", "mp41"]);     // 32 bytes: same stub, one more brand

const dir = await mkdtemp(path.join(tmpdir(), "camplat-empty-"));
const file = async (name, bytes) => { const p = path.join(dir, name); await writeFile(p, bytes); return p; };

await check("THE FEARED ONE: a stub is empty by its structure, whatever its size", async () => {
  eq(stub28.length, 28, "the bench stub is 28 bytes");
  eq(await hasVideoBoxes(await file("s28.mp4", stub28)), false, "28-byte ftyp only");
  eq(await hasVideoBoxes(await file("s32.mp4", stub32)), false, "32-byte ftyp only");
  eq(await hasVideoBoxes(await file("sfree.mp4", Buffer.concat([stub28, box("free", Buffer.alloc(40))]))), false, "ftyp + free, no media");
  eq(await hasVideoBoxes(await file("strunc.mp4", Buffer.concat([stub28, Buffer.from([0, 0, 1])]))), false, "ftyp + half a box header");
});

await check("THE FEARED ONE: a small file with media is never called empty", async () => {
  eq(await hasVideoBoxes(await file("mdat.mp4", Buffer.concat([stub28, box("mdat", Buffer.alloc(100))]))), true, "ftyp + mdat (136 bytes)");
  eq(await hasVideoBoxes(await file("moov.mp4", Buffer.concat([stub28, box("moov", Buffer.alloc(20))]))), true, "ftyp + moov");
  eq(await hasVideoBoxes(await file("moof.mp4", Buffer.concat([stub28, box("free"), box("moof", Buffer.alloc(8))]))), true, "ftyp + free + moof");
  const big = Buffer.alloc(16);
  big.writeUInt32BE(1, 0); big.write("mdat", 4, "latin1"); big.writeBigUInt64BE(10_000_000_000n, 8);
  eq(await hasVideoBoxes(await file("mdat64.mp4", Buffer.concat([stub28, big]))), true, "64-bit mdat header");
  const toEnd = Buffer.alloc(8); toEnd.write("mdat", 4, "latin1");
  eq(await hasVideoBoxes(await file("mdat0.mp4", Buffer.concat([stub28, toEnd, Buffer.alloc(50)]))), true, "mdat sized 0 (to end of file)");
});

await check("THE FEARED ONE: anything that is not our MP4 is kept, never called empty", async () => {
  eq(await hasVideoBoxes(await file("zeros.mp4", Buffer.alloc(4096))), true, "zero bytes (no ftyp)");
  eq(await hasVideoBoxes(await file("text.mp4", Buffer.from("this is not an mp4 file at all"))), true, "text");
  const bad = Buffer.concat([stub28, Buffer.from([0, 0, 0, 3]), Buffer.from("junk"), Buffer.alloc(30)]);
  eq(await hasVideoBoxes(await file("badsize.mp4", bad)), true, "a box size below 8 after the ftyp: malformed, kept");
  eq(await hasVideoBoxes(path.join(dir, "missing.mp4")), true, "unreadable: kept");
});

await check("a file too short for one box header is empty", async () => {
  for (const n of [0, 1, 7]) eq(await hasVideoBoxes(await file(`tiny${n}.mp4`, Buffer.alloc(n))), false, `${n} bytes`);
});

await check("THE FEARED ONE: recovery moves stubs aside, counts them as empty, and indexes none of them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "camplat-emptyrec-"));
  const idx = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-emptyidx-")), "index.db"));
  try {
    const wip = path.join(root, "cam-1", INPROGRESS);
    await mkdir(wip, { recursive: true });
    // An open row for a stub (the seal_partial path) ...
    await writeFile(path.join(wip, "1757500000.mp4"), stub28);
    idx.put({ cameraId: "cam-1", startUtc: new Date(1757500000_000).toISOString(), endUtc: null,
      path: `cam-1/${INPROGRESS}/1757500000.mp4`, bytes: null, state: "open", hold: false, pendingUpload: false, bitrateKbps: null, root });
    // ... an unindexed stub (the adopt path), and a real fragment after both.
    await writeFile(path.join(wip, "1757500060.mp4"), stub32);
    await writeFile(path.join(wip, "1757500120.mp4"), Buffer.concat([stub28, box("moov", Buffer.alloc(20)), box("mdat", Buffer.alloc(5000))]));

    const summary = await runRecovery(idx, [root]);
    eq(summary.empty, 2, "two stubs counted as empty");
    const rows = idx.all().filter((s) => s.cameraId === "cam-1");
    const paths = rows.map((r) => r.path);
    if (paths.some((p) => p.includes("1757500000") || p.includes("1757500060"))) throw new Error(`a stub is still indexed: ${JSON.stringify(paths)}`);
    const real = rows.find((r) => r.path.includes("1757500120"));
    if (!real) throw new Error(`the real fragment was not indexed under cam-1: ${JSON.stringify(idx.all())}`);
    eq(real.startUtc, "2025-09-10T10:28:40.000Z", "at its own start time");
    eq(real.state, "partial", "as a partial: a power cut interrupted it");
    eq(summary.partials + summary.adopted, 1, "only the real fragment is a partial or adopted");
    const moved = await readdir(path.join(root, QUARANTINE));
    eq(moved.length, 2, "both stubs are in quarantine, not deleted");
  } finally {
    idx.close();
  }
});

report("empty segments");
