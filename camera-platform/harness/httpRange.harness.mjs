/** Byte ranges for segment playback. The failures feared: a Content-Range built
 *  from the index's null size, an off-by-one that stalls the last byte, and a
 *  wrong 416 that stops a clip opening at all. */
import { planByteRange } from "../dist/httpRange.js";
import { check, same, throws, report } from "./_assert.mjs";

console.log("httpRange");

const SIZE = 15_000_000;   // one 60 s segment at 2000 kbps

check("no Range header: the whole file, nothing ignored", () => {
  for (const header of [undefined, null, "", "   "]) {
    same(planByteRange(header, SIZE), { kind: "full", status: 200, length: SIZE, ignored: null },
      `header ${JSON.stringify(header)}`);
  }
});

check("bytes=0-499 is the first 500 bytes, end inclusive", () => {
  same(planByteRange("bytes=0-499", SIZE),
    { kind: "partial", status: 206, start: 0, end: 499, length: 500, contentRange: `bytes 0-499/${SIZE}` },
    "plan");
});

check("the last byte exactly: bytes=size-1-size-1", () => {
  const p = planByteRange(`bytes=${SIZE - 1}-${SIZE - 1}`, SIZE);
  same([p.status, p.start, p.end, p.length], [206, SIZE - 1, SIZE - 1, 1], "one byte, not zero and not two");
});

check("an end past the file is clamped, not refused", () => {
  const p = planByteRange("bytes=100-99999999999", SIZE);
  same([p.status, p.start, p.end, p.length], [206, 100, SIZE - 1, SIZE - 100], "clamped");
  same(p.contentRange, `bytes 100-${SIZE - 1}/${SIZE}`, "Content-Range names the real end");
});

check("an absurdly long end number still clamps", () => {
  const p = planByteRange(`bytes=0-${"9".repeat(400)}`, SIZE);
  same([p.status, p.end], [206, SIZE - 1], "clamped, not NaN and not Infinity");
});

check("open-ended bytes=a- runs to the end", () => {
  const p = planByteRange("bytes=14000000-", SIZE);
  same([p.status, p.start, p.end, p.length], [206, 14_000_000, SIZE - 1, 1_000_000], "plan");
});

check("the browser's first request, bytes=0-, is a 206 of everything", () => {
  const p = planByteRange("bytes=0-", SIZE);
  same([p.status, p.start, p.end, p.length], [206, 0, SIZE - 1, SIZE], "206, not 200 — the player expects it");
});

check("suffix bytes=-500 is the last 500 bytes", () => {
  const p = planByteRange("bytes=-500", SIZE);
  same([p.status, p.start, p.end, p.length], [206, SIZE - 500, SIZE - 1, 500], "plan");
});

check("a suffix longer than the file is the whole file as a 206", () => {
  const p = planByteRange("bytes=-99999999999", SIZE);
  same([p.status, p.start, p.end, p.length], [206, 0, SIZE - 1, SIZE], "plan");
});

check("THE FEARED ONE: a start at or past the end is 416 with bytes */size", () => {
  for (const header of [`bytes=${SIZE}-`, `bytes=${SIZE}-${SIZE + 10}`, `bytes=${SIZE + 1}-`]) {
    same(planByteRange(header, SIZE), { kind: "unsatisfiable", status: 416, contentRange: `bytes */${SIZE}` },
      header);
  }
});

check("bytes=-0 is unsatisfiable, per RFC 9110", () => {
  same(planByteRange("bytes=-0", SIZE).status, 416, "status");
});

check("an empty file satisfies no range", () => {
  same(planByteRange("bytes=0-", 0), { kind: "unsatisfiable", status: 416, contentRange: "bytes */0" }, "0-");
  same(planByteRange("bytes=-5", 0).status, 416, "suffix");
  same(planByteRange(undefined, 0), { kind: "full", status: 200, length: 0, ignored: null }, "no header");
});

check("the unit is case-insensitive", () => {
  same(planByteRange("Bytes=0-9", SIZE).status, 206, "Bytes");
  same(planByteRange("BYTES=0-9", SIZE).status, 206, "BYTES");
});

check("a unit we do not know is ignored, never guessed at", () => {
  same(planByteRange("items=0-9", SIZE), { kind: "full", status: 200, length: SIZE, ignored: "unit" }, "items");
});

check("multiple ranges are ignored in favour of the whole file", () => {
  same(planByteRange("bytes=0-9,20-29", SIZE),
    { kind: "full", status: 200, length: SIZE, ignored: "multi_range" }, "two ranges");
  same(planByteRange("bytes=0-9, 20-29", SIZE).ignored, "multi_range", "with a space");
});

check("THE FEARED ONE: malformed headers are ignored, not half-parsed", () => {
  const bad = [
    "bytes=", "bytes=-", "bytes=5-3", "bytes=a-b", "bytes=1.5-9", "bytes=+1-9", "bytes=1e3-",
    "bytes=0x10-", "bytes= 0-9", "bytes=0 -9", "bytes=0-9 junk", "bytes", "bytes 0-9", "=0-9",
    "bytes=--5", "bytes=-5-",
  ];
  for (const header of bad) {
    same(planByteRange(header, SIZE), { kind: "full", status: 200, length: SIZE, ignored: "malformed" }, header);
  }
});

check("whitespace around the whole header is tolerated", () => {
  same(planByteRange("  bytes=0-9  ", SIZE).status, 206, "trimmed");
});

check("leading zeros are still numbers", () => {
  const p = planByteRange("bytes=0010-0019", SIZE);
  same([p.start, p.end, p.length], [10, 19, 10], "decimal, not octal");
});

check("THE FEARED ONE: the index's null size is refused, not read as zero", () => {
  throws(() => planByteRange("bytes=0-", null), "null size");
  throws(() => planByteRange(undefined, null), "null size with no header");
  throws(() => planByteRange("bytes=0-", undefined), "undefined size");
  throws(() => planByteRange("bytes=0-", -1), "negative size");
  throws(() => planByteRange("bytes=0-", 1.5), "fractional size");
  throws(() => planByteRange("bytes=0-", Number.NaN), "NaN size");
  throws(() => planByteRange("bytes=0-", "15000000"), "a string is not a size");
});

check("every 206 is internally consistent, over a sweep of headers", () => {
  const sizes = [1, 2, 499, 500, 501, SIZE];
  const headers = (n) => [
    "bytes=0-", "bytes=0-0", `bytes=0-${n - 1}`, `bytes=0-${n}`, `bytes=${n - 1}-`,
    "bytes=-1", `bytes=-${n}`, `bytes=-${n + 1}`, "bytes=1-1", "bytes=250-749",
  ];
  for (const n of sizes) {
    for (const h of headers(n)) {
      const p = planByteRange(h, n);
      if (p.status === 416) {
        same(p.contentRange, `bytes */${n}`, `${h} on ${n}`);
        continue;
      }
      if (p.status !== 206) throw new Error(`${h} on ${n}: expected 206 or 416, got ${p.status}`);
      if (!(p.start >= 0 && p.start <= p.end && p.end <= n - 1)) {
        throw new Error(`${h} on ${n}: range ${p.start}-${p.end} is outside 0-${n - 1}`);
      }
      same(p.length, p.end - p.start + 1, `${h} on ${n}: length`);
      same(p.contentRange, `bytes ${p.start}-${p.end}/${n}`, `${h} on ${n}: Content-Range`);
    }
  }
});

report("httpRange");
