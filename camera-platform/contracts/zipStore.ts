/**
 * Byte builders for a streamed, store-only ZIP32 archive.
 *
 * WHY store-only and streamed: an export is whole recorded MP4 segments, which
 * do not compress, and can be gigabytes. Each entry sets general-purpose flag
 * bit 3, so its CRC-32 and sizes follow the data in a data descriptor; the
 * server never holds a file in memory, never writes a temp file, and never
 * reads a segment twice. See EXPORT-SPEC.md.
 *
 * Archive layout:
 *   for each entry: localFileHeader | file bytes | dataDescriptor
 *   then: centralDirectoryHeader for each entry, in the same order
 *   then: endOfCentralDirectory
 *
 * Every multi-byte integer is unsigned little-endian. Every builder returns a
 * fresh Uint8Array. No imports and no TextEncoder: entry names are ASCII only
 * (checkEntryName), written one byte per character.
 */

export class ZipError extends Error {}

/** The largest size or offset a ZIP32 field can hold. */
export const ZIP32_MAX = 0xffff_ffff;
/** The largest entry count the end-of-central-directory record can hold. */
export const ZIP32_MAX_ENTRIES = 0xffff;

/** MS-DOS date and time fields, as two 16-bit values. */
export interface DosDateTime {
  time: number;
  date: number;
}

/** What the central directory needs to know about one entry already written. */
export interface CentralEntry {
  name: string;
  dos: DosDateTime;
  /** CRC-32 of the entry's bytes, unsigned (0 .. 0xFFFFFFFF). */
  crc: number;
  /** Byte count of the entry (stored, so compressed = uncompressed). */
  size: number;
  /** Byte offset of the entry's local file header from the start of the archive. */
  offset: number;
}

/**
 * Continue a CRC-32 (IEEE 802.3: reflected polynomial 0xEDB88320, initial value
 * and final xor 0xFFFFFFFF) over `bytes`.
 *
 * `crc` is the value returned for the bytes so far; start with 0. So
 * crc32Update(crc32Update(0, a), b) === crc32Update(0, a followed by b), for
 * any split, including an empty `a` or `b`. Returns an unsigned integer
 * (0 .. 0xFFFFFFFF), never negative: use `>>> 0`.
 *
 * Throws ZipError if `crc` is not an integer in 0 .. 0xFFFFFFFF.
 *
 * Known values: "" -> 0; "123456789" -> 0xCBF43926;
 * "The quick brown fox jumps over the lazy dog" -> 0x414FA339.
 */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  if (!Number.isInteger(crc) || crc < 0 || crc > 0xffffffff) {
    throw new ZipError("invalid crc");
  }
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    const index = (c ^ byte) & 0xff;
    const tblVal = CRC32_TABLE[index] ?? 0;
    c = tblVal ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
  }
  CRC32_TABLE[i] = crc >>> 0;
}

/**
 * The MS-DOS date and time for epoch milliseconds, in UTC (never local time).
 *
 * time = hours << 11 | minutes << 5 | floor(seconds / 2)
 * date = (year - 1980) << 9 | month << 5 | day      (month 1..12, day 1..31)
 * Milliseconds are dropped. Throws ZipError when `ms` is not finite, or when
 * its UTC year is before 1980 or after 2107 (the field holds 0..127).
 *
 * 2026-09-11T14:05:37.000Z -> { time: 28850, date: 23851 }
 * 1980-01-01T00:00:00.000Z -> { time: 0, date: 33 }
 */
export function dosDateTime(ms: number): DosDateTime {
  if (!Number.isFinite(ms)) {
    throw new ZipError("not a finite number");
  }
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1980 || year > 2107) {
    throw new ZipError("year out of range");
  }
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  const time = (hour << 11) | (minute << 5) | Math.floor(second / 2);
  const date = ((year - 1980) << 9) | (month << 5) | day;
  return { time, date };
}

/**
 * Throws ZipError unless `name` is a safe archive path: 1..255 characters,
 * one or more segments separated by single "/", each segment matching
 * /^[A-Za-z0-9._-]+$/ and not equal to "." or "..". So no leading or trailing
 * "/", no "//", no backslash, no drive letter, no space and no non-ASCII.
 * Returns nothing when the name is safe.
 */
export function checkEntryName(name: string): void {
  if (typeof name !== "string") {
    throw new ZipError("not a string");
  }
  if (name.length === 0 || name.length > 255) {
    throw new ZipError("name length out of range");
  }
  const parts = name.split("/");
  for (const part of parts) {
    if (part.length === 0) {
      throw new ZipError("empty segment");
    }
    if (part === "." || part === "..") {
      throw new ZipError("invalid segment");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(part)) {
      throw new ZipError("invalid segment");
    }
  }
}

/**
 * The local file header for a stored entry whose CRC and sizes follow in a
 * data descriptor. 30 bytes followed by the name's bytes. checkEntryName first.
 *
 * offset size field
 *  0     4    signature 0x04034b50
 *  4     2    version needed to extract: 20
 *  6     2    general purpose flags: 0x0008
 *  8     2    compression method: 0 (stored)
 * 10     2    dos.time
 * 12     2    dos.date
 * 14     4    crc-32: 0
 * 18     4    compressed size: 0
 * 22     4    uncompressed size: 0
 * 26     2    file name length
 * 28     2    extra field length: 0
 * 30     n    file name, one byte per character
 *
 * "a.txt", { time: 0, date: 33 } ->
 * 50 4b 03 04 14 00 08 00 00 00 00 00 21 00 00 00 00 00 00 00 00 00 00 00 00 00 05 00 00 00 61 2e 74 78 74
 */
export function localFileHeader(name: string, dos: DosDateTime): Uint8Array {
  checkEntryName(name);
  const u8 = new Uint8Array(30 + name.length);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 0x0008, true);
  dv.setUint16(8, 0, true);
  dv.setUint16(10, dos.time, true);
  dv.setUint16(12, dos.date, true);
  dv.setUint32(14, 0, true);
  dv.setUint32(18, 0, true);
  dv.setUint32(22, 0, true);
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, 0, true);
  for (let i = 0; i < name.length; i++) {
    u8[30 + i] = name.charCodeAt(i);
  }
  return u8;
}

/**
 * The data descriptor written after an entry's bytes. 16 bytes:
 *
 * offset size field
 *  0     4    signature 0x08074b50
 *  4     4    crc-32
 *  8     4    compressed size (= size)
 * 12     4    uncompressed size (= size)
 *
 * Throws ZipError when `crc` is not an integer in 0 .. 0xFFFFFFFF, or `size`
 * is not an integer in 0 .. ZIP32_MAX.
 */
export function dataDescriptor(crc: number, size: number): Uint8Array {
  if (!Number.isInteger(crc) || crc < 0 || crc > 0xffffffff) {
    throw new ZipError("invalid crc");
  }
  if (!Number.isInteger(size) || size < 0 || size > ZIP32_MAX) {
    throw new ZipError("invalid size");
  }
  const u8 = new Uint8Array(16);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  dv.setUint32(0, 0x08074b50, true);
  dv.setUint32(4, crc, true);
  dv.setUint32(8, size, true);
  dv.setUint32(12, size, true);
  return u8;
}

/**
 * One central directory file header. 46 bytes followed by the name's bytes.
 * checkEntryName first. Throws ZipError when crc is not an integer in
 * 0 .. 0xFFFFFFFF, or size or offset is not an integer in 0 .. ZIP32_MAX.
 *
 * offset size field
 *  0     4    signature 0x02014b50
 *  4     2    version made by: 20
 *  6     2    version needed to extract: 20
 *  8     2    general purpose flags: 0x0008
 * 10     2    compression method: 0
 * 12     2    dos.time
 * 14     2    dos.date
 * 16     4    crc-32
 * 20     4    compressed size (= size)
 * 24     4    uncompressed size (= size)
 * 28     2    file name length
 * 30     2    extra field length: 0
 * 32     2    file comment length: 0
 * 34     2    disk number start: 0
 * 36     2    internal file attributes: 0
 * 38     4    external file attributes: 0
 * 42     4    relative offset of local header (= offset)
 * 46     n    file name, one byte per character
 */
export function centralDirectoryHeader(entry: CentralEntry): Uint8Array {
  checkEntryName(entry.name);
  if (!Number.isInteger(entry.crc) || entry.crc < 0 || entry.crc > 0xffffffff) {
    throw new ZipError("invalid crc");
  }
  if (!Number.isInteger(entry.size) || entry.size < 0 || entry.size > ZIP32_MAX) {
    throw new ZipError("invalid size");
  }
  if (!Number.isInteger(entry.offset) || entry.offset < 0 || entry.offset > ZIP32_MAX) {
    throw new ZipError("invalid offset");
  }
  const u8 = new Uint8Array(46 + entry.name.length);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 20, true);
  dv.setUint16(8, 0x0008, true);
  dv.setUint16(10, 0, true);
  dv.setUint16(12, entry.dos.time, true);
  dv.setUint16(14, entry.dos.date, true);
  dv.setUint32(16, entry.crc, true);
  dv.setUint32(20, entry.size, true);
  dv.setUint32(24, entry.size, true);
  dv.setUint16(28, entry.name.length, true);
  dv.setUint16(30, 0, true);
  dv.setUint16(32, 0, true);
  dv.setUint16(34, 0, true);
  dv.setUint16(36, 0, true);
  dv.setUint32(38, 0, true);
  dv.setUint32(42, entry.offset, true);
  for (let i = 0; i < entry.name.length; i++) {
    u8[46 + i] = entry.name.charCodeAt(i);
  }
  return u8;
}

/**
 * The end-of-central-directory record. 22 bytes, no comment.
 *
 * offset size field
 *  0     4    signature 0x06054b50
 *  4     2    number of this disk: 0
 *  6     2    disk where central directory starts: 0
 *  8     2    central directory records on this disk (= entries)
 * 10     2    total central directory records (= entries)
 * 12     4    size of central directory in bytes (= cdSize)
 * 16     4    offset of start of central directory (= cdOffset)
 * 20     2    comment length: 0
 *
 * Throws ZipError when entries is not an integer in 0 .. ZIP32_MAX_ENTRIES,
 * cdSize or cdOffset is not a non-negative integer, or cdOffset + cdSize
 * exceeds ZIP32_MAX.
 */
export function endOfCentralDirectory(entries: number, cdSize: number, cdOffset: number): Uint8Array {
  if (!Number.isInteger(entries) || entries < 0 || entries > ZIP32_MAX_ENTRIES) {
    throw new ZipError("invalid entries");
  }
  if (!Number.isInteger(cdSize) || cdSize < 0) {
    throw new ZipError("invalid cdSize");
  }
  if (!Number.isInteger(cdOffset) || cdOffset < 0) {
    throw new ZipError("invalid cdOffset");
  }
  if (cdOffset > ZIP32_MAX - cdSize) {
    throw new ZipError("cdOffset + cdSize exceeds ZIP32_MAX");
  }
  const u8 = new Uint8Array(22);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, entries, true);
  dv.setUint16(10, entries, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  dv.setUint16(20, 0, true);
  return u8;
}
