/**
 * Where the detection gets marked on an event's thumbnail
 * (contracts/eventThumb.ts).
 *
 * The thumbnail is the WHOLE frame now, not a crop. The first real crop this
 * appliance produced put a person at 35% of the thumbnail's area and it still
 * read as "a car in a driveway" to someone seeing it cold, because a crop
 * throws away WHERE something happened. So the picture keeps everything and a
 * box says where to look.
 *
 * THE FEARED FAILURES: a mark that points at the wrong part of the picture,
 * which is worse than no mark at all because it is believed; a mark drawn
 * outside the frame, which ffmpeg refuses so the whole thumbnail is lost; and
 * a hairline that vanishes when a 2560-wide frame is shrunk to 480, leaving a
 * picture that looks unmarked.
 */
import { markRect, THUMB_WIDTH } from "../dist/eventThumb.js";
import { check, eq, report } from "./_assert.mjs";

console.log("event thumb");

const FRAME = { width: 2560, height: 1440 };
const isRefusal = (r) => r !== null && typeof r === "object" && r.ok === false;

check("THE FEARED ONE: the mark lands on the thing that was detected", () => {
  // Worked by hand: a box a quarter across and a third down a 2560x1440 frame
  // is at 640, 480, and a fifth wide by a tenth tall is 512 x 144.
  const m = markRect({ x: 0.25, y: 1 / 3, w: 0.2, h: 0.1 }, FRAME);
  eq(isRefusal(m), false, "answered");
  eq(m.x, 640, "x");
  eq(m.y, 480, "y");
  eq(m.w, 512, "w");
  eq(m.h, 144, "h");
});

check("the whole frame is kept: the mark is a rectangle ON it, not a window into it", () => {
  // A person filling the left edge — the real case that started this.
  const m = markRect({ x: 0.06511, y: 0.55235, w: 0.16129, h: 0.44053 }, FRAME);
  eq([m.x, m.y], [166, 795], "the real box, in pixels");
  eq([m.w, m.h], [413, 635], "and its size");
  // Nothing here describes a crop: the caller draws this and keeps the frame.
  eq(Object.keys(m).sort(), ["h", "ok", "thickness", "w", "x", "y"], "the whole answer");
});

check("THE FEARED ONE: a mark never leaves the frame, whatever the box says", () => {
  for (const box of [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0.999, y: 0.999, w: 0.001, h: 0.001 },
    { x: 0, y: 0, w: 0.0001, h: 0.0001 },
    { x: 0.9, y: 0.9, w: 0.1, h: 0.1 },
  ]) {
    const m = markRect(box, FRAME);
    eq(isRefusal(m), false, `planned ${JSON.stringify(box)}`);
    eq(m.x >= 0 && m.y >= 0, true, `starts inside: ${JSON.stringify(m)}`);
    eq(m.x + m.w <= FRAME.width, true, `ends inside horizontally: ${JSON.stringify(m)}`);
    eq(m.y + m.h <= FRAME.height, true, `ends inside vertically: ${JSON.stringify(m)}`);
    eq(m.w >= 1 && m.h >= 1, true, "and has some size");
  }
});

check("rounding goes outwards, so the mark never sits inside what it marks", () => {
  const m = markRect({ x: 0.10001, y: 0.10001, w: 0.10001, h: 0.10001 }, FRAME);
  eq(m.x <= 0.10001 * FRAME.width, true, "left edge at or before the box");
  eq(m.x + m.w >= (0.10001 + 0.10001) * FRAME.width, true, "right edge at or after it");
});

check("THE FEARED ONE: the line survives being shrunk to a thumbnail", () => {
  eq(THUMB_WIDTH, 480, "the thumbnail's width");
  const big = markRect({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, { width: 2560, height: 1440 });
  const shrunk = big.thickness * (THUMB_WIDTH / 2560);
  eq(shrunk >= 2, true, `a 2560-wide frame's line is ${shrunk} px once scaled to ${THUMB_WIDTH}`);
  const small = markRect({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, { width: 640, height: 480 });
  eq(small.thickness >= 2, true, `and never thinner than 2 on a small frame: ${small.thickness}`);
  eq(big.thickness > small.thickness, true, "a bigger frame gets a thicker line");
});

check("whole pixels only: ffmpeg's drawbox takes no fractions", () => {
  const m = markRect({ x: 0.1234567, y: 0.7654321, w: 0.0987654, h: 0.1357913 }, FRAME);
  for (const v of [m.x, m.y, m.w, m.h, m.thickness]) eq(Number.isInteger(v), true, `${v} is whole`);
});

check("THE FEARED ONE: an unreadable box is refused, never marked at a guess", () => {
  for (const bad of [
    null, "nope", 42, {},
    { x: 0.1, y: 0.1, w: 0.1 },
    { x: NaN, y: 0.1, w: 0.1, h: 0.1 },
    { x: 0.1, y: 0.1, w: 0, h: 0.1 },
    { x: -0.5, y: 0.1, w: 0.1, h: 0.1 },
    { x: 0.1, y: 0.1, w: 2, h: 0.1 },
  ]) {
    const r = markRect(bad, FRAME);
    eq(isRefusal(r), true, `refused ${JSON.stringify(bad)}`);
    eq(r.reason, "bad_box", "says why");
  }
});

check("an unreadable frame is refused too", () => {
  for (const bad of [null, {}, { width: 0, height: 100 }, { width: 100, height: -1 }, { width: "2560", height: 1440 }]) {
    const r = markRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, bad);
    eq(isRefusal(r), true, `refused frame ${JSON.stringify(bad)}`);
    eq(r.reason, "bad_frame", "says why");
  }
});

report("event thumb");
