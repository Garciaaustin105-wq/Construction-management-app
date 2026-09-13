/** An independent ZIP reader for the harnesses: walks the central directory,
 *  checks every local header, descriptor and offset against it, and checks
 *  every CRC with node:zlib, not with the code under test. Throws on any
 *  disagreement. Returns entries in central-directory order. */
import { crc32 as zlibCrc32 } from "node:zlib";
import { eq, same } from "./_assert.mjs";

export function readZip(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  eq(v.getUint32(eocd, true), 0x06054b50, "eocd signature at the very end");
  const entries = v.getUint16(eocd + 10, true);
  eq(v.getUint16(eocd + 8, true), entries, "entries on this disk = total");
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  eq(cdOffset + cdSize, eocd, "central directory ends where the eocd starts");
  const out = [];
  let p = cdOffset;
  let expectLocal = 0;
  for (let i = 0; i < entries; i++) {
    eq(v.getUint32(p, true), 0x02014b50, `central ${i} signature`);
    eq(v.getUint16(p + 8, true), 0x0008, `central ${i} flags`);
    eq(v.getUint16(p + 10, true), 0, `central ${i} stored`);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    eq(csize, usize, `central ${i} stored sizes`);
    const n = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = String.fromCharCode(...zip.subarray(p + 46, p + 46 + n));
    eq(offset, expectLocal, `entry ${i} local header immediately follows the previous entry`);
    eq(v.getUint32(offset, true), 0x04034b50, `local ${i} signature`);
    eq(v.getUint16(offset + 6, true), 0x0008, `local ${i} flags`);
    eq(String.fromCharCode(...zip.subarray(offset + 30, offset + 30 + v.getUint16(offset + 26, true))), name, `local ${i} name`);
    same([v.getUint16(offset + 10, true), v.getUint16(offset + 12, true)],
      [v.getUint16(p + 12, true), v.getUint16(p + 14, true)], `entry ${i} time/date agree`);
    const dataStart = offset + 30 + n + v.getUint16(offset + 28, true);
    const data = zip.subarray(dataStart, dataStart + usize);
    eq(zlibCrc32(data), crc, `entry ${i} crc from node:zlib`);
    const d = dataStart + usize;
    eq(v.getUint32(d, true), 0x08074b50, `entry ${i} descriptor signature`);
    same([v.getUint32(d + 4, true), v.getUint32(d + 8, true), v.getUint32(d + 12, true)], [crc, usize, usize], `entry ${i} descriptor`);
    expectLocal = d + 16;
    out.push({ name, data, time: v.getUint16(p + 12, true), date: v.getUint16(p + 14, true) });
    p += 46 + n + extra + comment;
  }
  eq(expectLocal, cdOffset, "central directory immediately follows the last entry");
  eq(p, eocd, "walked exactly the central directory");
  return out;
}
