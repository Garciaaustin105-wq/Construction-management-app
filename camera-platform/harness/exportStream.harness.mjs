/** The export stream. The failures feared: an archive that completes, and
 *  opens, while a file in it is short, or missing, or has grown; bytes past
 *  the plan sent anyway; backpressure ignored, so a slow client buffers a
 *  multi-GB export in memory; a read stream left open after the client leaves;
 *  and a filesystem path in an error. Every archive is read back with the
 *  independent reader in _zipReader.mjs. */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createHash, randomBytes } from "node:crypto";

import { streamExport, streamFile, writeChunk, ExportStreamError } from "../agent/exportStream.mjs";
import { planExport, exportManifest } from "../dist/exportPlan.js";
import { dosDateTime } from "../dist/zipStore.js";
import { check, eq, same, report } from "./_assert.mjs";
import { readZip } from "./_zipReader.mjs";

console.log("exportStream");

const CAM = "cam-1";
const M = 60_000;
const H = (h, m = 0, s = 0) => Date.UTC(2026, 8, 11, h, m, s);
const iso = (ms) => new Date(ms).toISOString();
const NOW = iso(H(15));
const GEN = iso(H(15, 1, 2));
const SITE = "carwash-01";

const dir = mkdtempSync(join(tmpdir(), "export-stream-"));
const resolvePath = (p) => join(dir, p);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** Write segment files and plan an export over them. sizes[i] null = no file. */
function fixture(tag, contents, { planBytes } = {}) {
  const segments = contents.map((data, i) => {
    const startMs = H(14, i);
    const path = `${tag}/${startMs}.mp4`;
    return { cameraId: CAM, startUtc: iso(startMs), endUtc: iso(startMs + M), path, state: "sealed", bitrateKbps: 2000,
      bytes: planBytes?.[i] ?? (data === null ? 10 : data.length) };
  });
  contents.forEach((data, i) => {
    if (data === null) return;
    writeFileSync(join(dir, segments[i].path), data);
  });
  const plan = planExport(CAM, segments, [], { startUtc: iso(H(14, 0)), endUtc: iso(H(14, contents.length)) }, NOW);
  if (plan.ok !== true) throw new Error(`fixture refused: ${plan.message}`);
  return plan;
}

/** A Writable that collects everything, optionally slowly, recording the
 *  most ever buffered inside it at the moment of a write call. */
function sink({ highWaterMark = 16 * 1024, slow = false } = {}) {
  const chunks = [];
  const w = new Writable({
    highWaterMark,
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      if (slow) setTimeout(cb, 1); else cb();
    },
  });
  w.maxBuffered = 0;
  const realWrite = w.write.bind(w);
  w.write = (chunk, ...rest) => {
    w.maxBuffered = Math.max(w.maxBuffered, w.writableLength);
    return realWrite(chunk, ...rest);
  };
  w.bytes = () => new Uint8Array(Buffer.concat(chunks));
  return w;
}

async function rejectsWith(promise, code, what) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  if (err === null) throw new Error(`${what}: expected ExportStreamError ${code}, it resolved`);
  if (!(err instanceof ExportStreamError)) throw new Error(`${what}: expected ExportStreamError, got ${err?.constructor?.name}: ${err?.message}`);
  eq(err.code, code, `${what}: code`);
  if (err.message.includes(dir)) throw new Error(`${what}: a filesystem path in the message: ${err.message}`);
  return err;
}

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const hasEocd = (u8) => Buffer.from(u8).includes(EOCD);

// Files go under per-check subdirectories, which must exist.
import { mkdirSync } from "node:fs";
const tagDir = (tag) => { mkdirSync(join(dir, tag), { recursive: true }); return tag; };

try {
  await check("round trip: every file byte for byte, in plan order, manifest.json last and matching what was sent", async () => {
    const data = [randomBytes(70_001), Buffer.alloc(0), randomBytes(200_000)];
    const plan = fixture(tagDir("rt"), data);
    const out = sink();
    const result = await streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN });
    const zip = out.bytes();
    const entries = readZip(zip);
    same(entries.map((e) => e.name), [...plan.files.map((f) => f.name), "manifest.json"], "entry names");
    data.forEach((d, i) => {
      if (!Buffer.from(entries[i].data).equals(d)) throw new Error(`entry ${i}: bytes differ`);
    });
    same(result.sent, plan.files.map((f, i) => ({ name: f.name, bytes: data[i].length, sha256: sha(data[i]) })), "sent");
    eq(result.archiveBytes, zip.length, "archiveBytes is what was written");
    const manifestText = Buffer.from(entries[3].data).toString("latin1");
    eq(manifestText, exportManifest(plan, result.sent, SITE, GEN), "manifest is exportManifest of what was sent");
    eq(out.writableEnded, false, "streamExport does not end out");
  });

  await check("entry times: each file's DOS time is its segment start; the manifest's is generatedAtUtc", async () => {
    const plan = fixture(tagDir("dos"), [Buffer.from("a"), Buffer.from("bc")]);
    const out = sink();
    await streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN });
    const entries = readZip(out.bytes());
    same(entries.map((e) => ({ time: e.time, date: e.date })),
      [dosDateTime(H(14, 0)), dosDateTime(H(14, 1)), dosDateTime(H(15, 1, 2))], "dos times");
  });

  await check("THE FEARED ONE: a file shorter than planned rejects, and no archive end is ever written", async () => {
    const plan = fixture(tagDir("short"), [randomBytes(5000), randomBytes(4000)], { planBytes: [5000, 4001] });
    const out = sink();
    await rejectsWith(streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN }), "file_size_changed", "short");
    const bytes = out.bytes();
    if (hasEocd(bytes)) throw new Error("an end-of-central-directory record was written");
    if (Buffer.from(bytes).includes(Buffer.from("manifest.json"))) throw new Error("the manifest was written");
  });

  await check("THE FEARED ONE: a file longer than planned rejects, and not one byte past the plan is sent", async () => {
    const tail = Buffer.from("PAST-THE-PLAN-MARKER");
    const body = Buffer.concat([randomBytes(3000), tail]);
    const plan = fixture(tagDir("long"), [body], { planBytes: [3000] });
    const out = sink();
    const opened = [];
    const openRead = (p) => { const s = createReadStream(p, { highWaterMark: 1000 }); opened.push(s); return s; };
    await rejectsWith(streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN, openRead }), "file_size_changed", "long");
    const bytes = Buffer.from(out.bytes());
    if (bytes.includes(tail.subarray(0, 8))) throw new Error("bytes past the plan were sent");
    if (hasEocd(bytes)) throw new Error("an end-of-central-directory record was written");
    eq(opened.every((s) => s.destroyed), true, "the read stream is destroyed");
  });

  await check("THE FEARED ONE: a missing file (evicted after planning) rejects as file_missing, no archive end", async () => {
    const plan = fixture(tagDir("missing"), [randomBytes(100), null]);
    const out = sink();
    const err = await rejectsWith(streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN }), "file_missing", "missing");
    if (!err.message.includes(plan.files[1].name)) throw new Error(`message does not name the entry: ${err.message}`);
    if (hasEocd(out.bytes())) throw new Error("an end-of-central-directory record was written");
  });

  await check("THE FEARED ONE: backpressure is honoured; a slow client never has the export buffered in memory", async () => {
    const data = [randomBytes(300_000)];
    const plan = fixture(tagDir("bp"), data);
    const out = sink({ highWaterMark: 16 * 1024, slow: true });
    const openRead = (p) => createReadStream(p, { highWaterMark: 4096 });
    await streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN, openRead });
    if (out.maxBuffered > 16 * 1024 + 4096) throw new Error(`buffered ${out.maxBuffered} bytes at once`);
    readZip(out.bytes());
  });

  await check("THE FEARED ONE: the client leaving mid-export rejects as client_gone and closes the file", async () => {
    const plan = fixture(tagDir("gone"), [randomBytes(400_000)]);
    const out = sink({ highWaterMark: 1024, slow: true });
    const opened = [];
    const openRead = (p) => { const s = createReadStream(p, { highWaterMark: 4096 }); opened.push(s); return s; };
    const p = streamExport(out, plan, { resolvePath, siteId: SITE, generatedAtUtc: GEN, openRead });
    setTimeout(() => out.destroy(), 20);
    await rejectsWith(p, "client_gone", "gone");
    eq(opened.length, 1, "one file opened");
    eq(opened[0].destroyed, true, "the read stream is destroyed");
  });

  await check("writeChunk: refuses a destroyed stream without writing; resolves after drain", async () => {
    const dead = sink();
    dead.destroy();
    await rejectsWith(writeChunk(dead, new Uint8Array(1)), "client_gone", "destroyed");
    const out = sink({ highWaterMark: 4, slow: true });
    await writeChunk(out, new Uint8Array(100));
    eq(out.writableLength, 0, "drained before resolving");
  });

  await check("writeChunk: a stream that closes while waiting for drain rejects, and leaves no listeners", async () => {
    const out = sink({ highWaterMark: 4, slow: true });
    const before = ["drain", "close", "error"].map((e) => out.listenerCount(e));
    const p = writeChunk(out, new Uint8Array(100));
    out.destroy();
    await rejectsWith(p, "client_gone", "closed");
    same(["drain", "close", "error"].map((e) => out.listenerCount(e)), before, "listeners removed");
  });

  await check("streamFile alone: returns crc, bytes and sha256 of exactly what it wrote", async () => {
    const data = randomBytes(12_345);
    const p = join(dir, "single.bin");
    writeFileSync(p, data);
    const out = sink();
    const r = await streamFile(out, { name: "cam-1/x.mp4", bytes: data.length }, p, createReadStream);
    same(Object.keys(r).sort(), ["bytes", "crc", "sha256"], "keys");
    same([r.bytes, r.sha256], [data.length, sha(data)], "measured");
    const { crc32 } = await import("node:zlib");
    eq(r.crc, crc32(data), "crc");
    if (!Buffer.from(out.bytes()).equals(data)) throw new Error("wrote different bytes");
    eq(readFileSync(p).length, data.length, "file untouched");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

report("exportStream");
