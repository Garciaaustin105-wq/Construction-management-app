/** Store-only streamed ZIP32 byte builders. The failures feared: a CRC that is
 *  right for one chunk and wrong across chunk boundaries (every multi-GB file
 *  is read in chunks); a signed CRC written as garbage; a local-time timestamp;
 *  a name that escapes the extraction folder; and an offset past 4 GiB that
 *  silently wraps. The round trip at the end reads the archive back with an
 *  independent reader and node's own crc32. */
import { crc32 as zlibCrc32 } from "node:zlib";
import { randomBytes } from "node:crypto";
import {
  crc32Update, dosDateTime, checkEntryName, localFileHeader, dataDescriptor,
  centralDirectoryHeader, endOfCentralDirectory, ZIP32_MAX, ZIP32_MAX_ENTRIES,
} from "../dist/zipStore.js";
import { check, eq, same, throws, report } from "./_assert.mjs";
import { readZip } from "./_zipReader.mjs";

console.log("zipStore");

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join(" ");
const unhex = (s) => Uint8Array.from(s.trim().split(/\s+/), (h) => parseInt(h, 16));
const isU8 = (v) => v instanceof Uint8Array;

// ---- crc32Update -----------------------------------------------------------

check("crc32: the published check values", () => {
  eq(crc32Update(0, new Uint8Array(0)), 0, "empty");
  eq(crc32Update(0, ascii("123456789")), 0xcbf43926, "123456789");
  eq(crc32Update(0, ascii("The quick brown fox jumps over the lazy dog")), 0x414fa339, "fox");
});

check("crc32: unsigned, never negative (high bit set)", () => {
  const v = crc32Update(0, ascii("123456789"));
  if (!(v > 0x7fffffff && v <= 0xffffffff)) throw new Error(`expected an unsigned value above 2^31, got ${v}`);
});

check("crc32: agrees with node:zlib on random buffers of many lengths", () => {
  for (const n of [1, 2, 3, 7, 8, 255, 256, 1023, 4096, 65537]) {
    const buf = randomBytes(n);
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    eq(crc32Update(0, u8), zlibCrc32(buf), `length ${n}`);
  }
});

check("THE FEARED ONE: incremental across EVERY split point equals one pass", () => {
  const buf = randomBytes(97);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const whole = zlibCrc32(buf);
  for (let i = 0; i <= u8.length; i++) {
    eq(crc32Update(crc32Update(0, u8.subarray(0, i)), u8.subarray(i)), whole, `split at ${i}`);
  }
  // Three chunks, including empty ones in the middle.
  let c = 0;
  for (const part of [u8.subarray(0, 10), u8.subarray(10, 10), u8.subarray(10, 60), u8.subarray(60)]) {
    c = crc32Update(c, part);
  }
  eq(c, whole, "chunks with an empty one");
});

check("crc32: respects a subarray's offset, not the underlying buffer", () => {
  const big = ascii("xx123456789yy");
  eq(crc32Update(0, big.subarray(2, 11)), 0xcbf43926, "subarray");
});

check("crc32: refuses a running value that is not an unsigned 32-bit integer", () => {
  const b = ascii("a");
  throws(() => crc32Update(-1, b), "-1");
  throws(() => crc32Update(0x1_0000_0000, b), "2^32");
  throws(() => crc32Update(1.5, b), "1.5");
  throws(() => crc32Update(NaN, b), "NaN");
});

// ---- dosDateTime -----------------------------------------------------------

check("dos: pinned values", () => {
  same(dosDateTime(Date.UTC(2026, 8, 11, 14, 5, 37)), { time: 28850, date: 23851 }, "2026-09-11T14:05:37Z");
  same(dosDateTime(Date.UTC(1980, 0, 1)), { time: 0, date: 33 }, "1980-01-01");
  same(dosDateTime(Date.UTC(2107, 11, 31, 23, 59, 59, 999)), { time: 49021, date: 65439 }, "2107-12-31T23:59:59.999Z");
});

check("THE FEARED ONE: UTC, not local time (an instant just after UTC midnight)", () => {
  // Anywhere west of Greenwich this is still 2026-09-10 locally.
  same(dosDateTime(Date.UTC(2026, 8, 11, 0, 30, 0)), { time: 960, date: 23851 }, "00:30Z on the 11th");
  // East of Greenwich, just before UTC midnight is already the 12th locally.
  same(dosDateTime(Date.UTC(2026, 8, 11, 23, 30, 0)), { time: 48064, date: 23851 }, "23:30Z on the 11th");
});

check("dos: odd seconds round down, milliseconds dropped", () => {
  same(dosDateTime(Date.UTC(2026, 8, 11, 14, 5, 37, 999)), { time: 28850, date: 23851 }, ".999");
  same(dosDateTime(Date.UTC(2026, 8, 11, 14, 5, 36)), { time: 28850, date: 23851 }, ":36 and :37 share a slot");
});

check("dos: refuses what the fields cannot hold", () => {
  throws(() => dosDateTime(Date.UTC(1979, 11, 31, 23, 59, 59)), "1979");
  throws(() => dosDateTime(Date.UTC(2108, 0, 1)), "2108");
  throws(() => dosDateTime(NaN), "NaN");
  throws(() => dosDateTime(Infinity), "Infinity");
});

// ---- checkEntryName --------------------------------------------------------

check("names: accepts what an export writes", () => {
  for (const n of ["a.txt", "manifest.json", "cam-1/2026-09-11T14-05-00.000Z.mp4", "a/b/c_d-e.f", "x".repeat(255)]) {
    checkEntryName(n);
  }
});

check("THE FEARED ONE: names that escape the folder, or cannot be written as ASCII, are refused", () => {
  const bad = [
    "", "/a", "a/", "a//b", "a\\b", "C:/a", "C:a", "../a", "a/../b", "a/./b", ".", "..", "a/..",
    "a b", "caf\u00e9.mp4", "a\u0000b", "a\nb", "x".repeat(256),
  ];
  for (const n of bad) throws(() => checkEntryName(n), JSON.stringify(n));
});

// ---- localFileHeader -------------------------------------------------------

check("local header: pinned bytes", () => {
  const h = localFileHeader("a.txt", { time: 0, date: 33 });
  if (!isU8(h)) throw new Error("not a Uint8Array");
  eq(hex(h), "50 4b 03 04 14 00 08 00 00 00 00 00 21 00 00 00 00 00 00 00 00 00 00 00 00 00 05 00 00 00 61 2e 74 78 74", "bytes");
});

check("local header: time and date little-endian, name length follows the name", () => {
  const name = "cam-1/2026-09-11T14-05-00.000Z.mp4";
  const h = localFileHeader(name, { time: 28850, date: 23851 });
  eq(h.length, 30 + name.length, "length");
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  same([v.getUint16(10, true), v.getUint16(12, true), v.getUint16(26, true)], [28850, 23851, name.length], "fields");
  eq(String.fromCharCode(...h.subarray(30)), name, "name bytes");
});

check("local header: refuses an unsafe name", () => {
  throws(() => localFileHeader("../evil.mp4", { time: 0, date: 33 }), "..");
});

// ---- dataDescriptor --------------------------------------------------------

check("descriptor: pinned bytes", () => {
  const d = dataDescriptor(0xcbf43926, 9);
  if (!isU8(d)) throw new Error("not a Uint8Array");
  eq(hex(d), "50 4b 07 08 26 39 f4 cb 09 00 00 00 09 00 00 00", "bytes");
  eq(hex(dataDescriptor(0xffffffff, ZIP32_MAX)), "50 4b 07 08 ff ff ff ff ff ff ff ff ff ff ff ff", "maxima");
});

check("THE FEARED ONE: a size or crc a ZIP32 field cannot hold is refused, not wrapped", () => {
  throws(() => dataDescriptor(0, ZIP32_MAX + 1), "size 2^32");
  throws(() => dataDescriptor(0, -1), "size -1");
  throws(() => dataDescriptor(0, 1.5), "size 1.5");
  throws(() => dataDescriptor(0x1_0000_0000, 0), "crc 2^32");
  throws(() => dataDescriptor(-1, 0), "crc -1");
});

// ---- centralDirectoryHeader ------------------------------------------------

check("central header: pinned bytes", () => {
  const h = centralDirectoryHeader({ name: "a.txt", dos: { time: 0, date: 33 }, crc: 0xcbf43926, size: 9, offset: 0x01020304 });
  if (!isU8(h)) throw new Error("not a Uint8Array");
  eq(hex(h),
    "50 4b 01 02 14 00 14 00 08 00 00 00 00 00 21 00 26 39 f4 cb 09 00 00 00 09 00 00 00 05 00 00 00 " +
    "00 00 00 00 00 00 00 00 00 00 04 03 02 01 61 2e 74 78 74", "bytes");
});

check("central header: refuses what cannot be written", () => {
  const ok = { name: "a.txt", dos: { time: 0, date: 33 }, crc: 0, size: 0, offset: 0 };
  centralDirectoryHeader(ok);
  throws(() => centralDirectoryHeader({ ...ok, name: "a/../../b" }), "name");
  throws(() => centralDirectoryHeader({ ...ok, offset: ZIP32_MAX + 1 }), "offset 2^32");
  throws(() => centralDirectoryHeader({ ...ok, size: ZIP32_MAX + 1 }), "size 2^32");
  throws(() => centralDirectoryHeader({ ...ok, crc: -1 }), "crc -1");
  centralDirectoryHeader({ ...ok, offset: ZIP32_MAX, size: ZIP32_MAX, crc: 0xffffffff });
});

// ---- endOfCentralDirectory -------------------------------------------------

check("eocd: pinned bytes", () => {
  const e = endOfCentralDirectory(2, 0x5c, 0x1000);
  if (!isU8(e)) throw new Error("not a Uint8Array");
  eq(hex(e), "50 4b 05 06 00 00 00 00 02 00 02 00 5c 00 00 00 00 10 00 00 00 00", "bytes");
});

check("THE FEARED ONE: eocd past the entry or offset limit is refused; exactly at it is not", () => {
  endOfCentralDirectory(ZIP32_MAX_ENTRIES, 0, 0);
  endOfCentralDirectory(1, 46, ZIP32_MAX - 46);
  throws(() => endOfCentralDirectory(ZIP32_MAX_ENTRIES + 1, 0, 0), "65536 entries");
  throws(() => endOfCentralDirectory(1, 47, ZIP32_MAX - 46), "offset + size one past");
  throws(() => endOfCentralDirectory(-1, 0, 0), "negative entries");
  throws(() => endOfCentralDirectory(1, 1.5, 0), "fractional size");
  throws(() => endOfCentralDirectory(1, 0, -1), "negative offset");
});

// ---- round trip ------------------------------------------------------------

/** An independent reader: trusts nothing the builders did, checks everything. */

check("round trip: an archive built from the pieces reads back byte for byte", () => {
  const dos = dosDateTime(Date.UTC(2026, 8, 11, 14, 5, 37));
  const files = [
    { name: "cam-1/2026-09-11T14-05-00.000Z.mp4", data: new Uint8Array(randomBytes(70_001)) },
    { name: "cam-1/empty.bin", data: new Uint8Array(0) },
    { name: "manifest.json", data: ascii('{"note":"UTC"}') },
  ];
  const parts = [];
  const central = [];
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.length; };
  for (const f of files) {
    const at = offset;
    push(localFileHeader(f.name, dos));
    // Stream the data in uneven chunks, as the route will.
    let crc = 0;
    for (let i = 0; i < f.data.length; i += 8191) {
      const chunk = f.data.subarray(i, i + 8191);
      crc = crc32Update(crc, chunk);
      push(chunk);
    }
    push(dataDescriptor(crc, f.data.length));
    central.push({ name: f.name, dos, crc, size: f.data.length, offset: at });
  }
  const cdOffset = offset;
  for (const c of central) push(centralDirectoryHeader(c));
  push(endOfCentralDirectory(central.length, offset - cdOffset, cdOffset));
  const zip = new Uint8Array(offset);
  let w = 0;
  for (const u8 of parts) { zip.set(u8, w); w += u8.length; }

  const read = readZip(zip);
  same(read.map((r) => r.name), files.map((f) => f.name), "names in order");
  read.forEach((r, i) => {
    const f = files[i];
    if (r.data.length !== f.data.length || !r.data.every((b, j) => b === f.data[j])) {
      throw new Error(`entry ${f.name}: bytes differ`);
    }
  });
});

report("zipStore");
