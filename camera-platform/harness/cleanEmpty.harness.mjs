/**
 * `camctl clean-empty`: segments indexed before the stub fix (5052852) that
 * hold no video. The laptop NVR has a few from the 2026-09-18 restarts; any
 * box that recorded before that commit may too.
 *
 * THE FEARED FAILURES: a real recording moved because it looked small or
 * odd; anything moved without --apply; the file moved but its row left
 * pointing at nothing (or the row removed and the file left); the segment
 * being written right now touched; a row whose file is simply missing
 * treated as empty.
 */
import { mkdtemp, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanEmptySegments } from "../agent/recorder-service.mjs";
import { openIndex } from "../agent/segindex.mjs";
import { INPROGRESS, QUARANTINE } from "../agent/segstore.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("clean empty");

const box = (type, payload = Buffer.alloc(0)) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, "latin1");
  payload.copy(b, 8);
  return b;
};
const STUB = box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "latin1")); // ffmpeg's 28 bytes
const REAL = Buffer.concat([STUB, box("moov", Buffer.alloc(40, 3)), box("mdat", Buffer.alloc(120, 9))]); // small, and real

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "camplat-clean-"));
  const idx = openIndex(path.join(await mkdtemp(path.join(tmpdir(), "camplat-cleanidx-")), "index.db"));
  await mkdir(path.join(root, "cam-1", INPROGRESS), { recursive: true });
  const row = (name, state, startMs, bytes) => ({
    cameraId: "cam-1", startUtc: new Date(startMs).toISOString(), endUtc: state === "open" ? null : new Date(startMs + 60_000).toISOString(),
    path: name, bytes, state, hold: false, pendingUpload: false, bitrateKbps: null, root,
  });
  const put = async (name, bytes, state, startMs, onDisk = true) => {
    if (onDisk) await writeFile(path.join(root, name), bytes);
    idx.put(row(name, state, startMs, bytes.length));
  };
  await put("cam-1/1757500000000.mp4", STUB, "partial", 1757500000000);      // the target
  await put("cam-1/1757500060000.mp4", STUB, "sealed", 1757500060000);       // a sealed stub too
  await put("cam-1/1757500120000.mp4", REAL, "sealed", 1757500120000);       // small but real
  await put("cam-1/1757500180000.mp4", Buffer.alloc(5000), "sealed", 1757500180000); // not our MP4: never ours to call empty
  await put("cam-1/1757500240000.mp4", STUB, "sealed", 1757500240000, false); // row, no file: lost, not empty
  await put(`cam-1/${INPROGRESS}/1757500300.mp4`, STUB, "open", 1757500300000); // being written now
  return { root, idx };
}
const paths = (idx) => idx.all().map((s) => s.path).sort();

await check("THE FEARED ONE: without --apply nothing moves and no row changes", async () => {
  const { root, idx } = await fixture();
  try {
    const before = paths(idx);
    const r = await cleanEmptySegments(idx, [root], { apply: false });
    eq(r.empty.map((e) => e.path).sort(), ["cam-1/1757500000000.mp4", "cam-1/1757500060000.mp4"], "the two stubs are listed");
    eq(r.moved, 0, "nothing moved");
    eq(paths(idx), before, "every row still there");
    eq((await stat(path.join(root, "cam-1/1757500000000.mp4"))).size, 28, "the stub still in place");
  } finally {
    idx.close();
  }
});

await check("THE FEARED ONE: --apply moves only the stubs, to quarantine, and removes exactly their rows", async () => {
  const { root, idx } = await fixture();
  try {
    const r = await cleanEmptySegments(idx, [root], { apply: true });
    eq(r.moved, 2, "two moved");
    eq(r.failed, [], "no failures");
    eq(paths(idx), [
      "cam-1/.inprogress/1757500300.mp4", "cam-1/1757500120000.mp4", "cam-1/1757500180000.mp4", "cam-1/1757500240000.mp4",
    ], "the real, the not-ours, the lost and the open rows are untouched");
    eq((await readdir(path.join(root, QUARANTINE))).length, 2, "both stubs in quarantine, not deleted");
    eq((await stat(path.join(root, "cam-1/1757500120000.mp4"))).size, REAL.length, "the small real recording kept");
    eq((await stat(path.join(root, "cam-1", INPROGRESS, "1757500300.mp4"))).size, 28, "the open file never touched, stub or not");
    eq(r.missing, 1, "the row without a file is reported as missing, not empty");
  } finally {
    idx.close();
  }
});

await check("a second --apply finds nothing more to do", async () => {
  const { root, idx } = await fixture();
  try {
    await cleanEmptySegments(idx, [root], { apply: true });
    const again = await cleanEmptySegments(idx, [root], { apply: true });
    eq([again.empty.length, again.moved], [0, 0], "idempotent");
  } finally {
    idx.close();
  }
});

await check("a row indexed before rows carried their drive is found on whichever store root holds it", async () => {
  const { root, idx } = await fixture();
  const other = await mkdtemp(path.join(tmpdir(), "camplat-clean2-"));
  try {
    idx.db.prepare("UPDATE segments SET root = NULL WHERE path = ?").run("cam-1/1757500000000.mp4");
    const r = await cleanEmptySegments(idx, [other, root], { apply: false });
    eq(r.empty.some((e) => e.path === "cam-1/1757500000000.mp4" && e.root === root), true, "found on the second root");
  } finally {
    idx.close();
  }
});

report("clean empty");
