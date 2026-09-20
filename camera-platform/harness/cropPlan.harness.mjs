/**
 * Where to cut a thumbnail out of a recorded frame, so an operator can see
 * WHAT fired without playing the clip (contracts/cropPlan.ts).
 *
 * This exists because of a real morning: a spray bottle was reported as a
 * person 77 times, and finding that out cost an ffmpeg cut and an agent
 * looking at the picture. With a crop on the tile it would have been a glance.
 *
 * THE FEARED FAILURES:
 * - a crop that does not contain the thing that was detected, so the operator
 *   looks at an empty wall and concludes the detector is broken;
 * - a crop that runs off the edge of the frame, which ffmpeg either refuses or,
 *   worse, silently clamps into a different picture than the one asked for;
 * - a box at the very edge (the bottle was at x=0.0015) producing a sliver
 *   instead of a thumbnail;
 * - a tiny far-away detection cropped so tightly that the result is six pixels
 *   of grey nobody can identify.
 */
import { planCrop, CROP_PAD, CROP_MIN_PX } from "../dist/cropPlan.js";
import { check, eq, report } from "./_assert.mjs";

console.log("crop plan");

const FRAME = { width: 2560, height: 1440 };
const isRefusal = (r) => r !== null && typeof r === "object" && r.ok === false;
const inFrame = (c, frame = FRAME) =>
  c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 && c.x + c.w <= frame.width && c.y + c.h <= frame.height;

check("THE FEARED ONE: the crop always contains the whole box it was asked for", () => {
  const boxes = [
    { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },      // middle
    { x: 0.0015, y: 0.3675, w: 0.2145, h: 0.6208 },  // the real spray bottle, hard against the left edge
    { x: 0.9, y: 0.9, w: 0.09, h: 0.09 },    // bottom right corner
    { x: 0, y: 0, w: 0.05, h: 0.05 },        // top left corner
    { x: 0.45, y: 0, w: 0.1, h: 1 },         // full height
  ];
  for (const box of boxes) {
    const c = planCrop(box, FRAME);
    eq(isRefusal(c), false, `planned for ${JSON.stringify(box)}`);
    eq(inFrame(c), true, `inside the frame: ${JSON.stringify(c)}`);
    // The box in pixels must sit entirely inside the crop.
    const bx = box.x * FRAME.width, by = box.y * FRAME.height;
    const bw = box.w * FRAME.width, bh = box.h * FRAME.height;
    eq(c.x <= Math.ceil(bx) && c.y <= Math.ceil(by), true, `crop starts at or before the box: ${JSON.stringify(c)}`);
    eq(c.x + c.w >= Math.floor(bx + bw) && c.y + c.h >= Math.floor(by + bh), true,
      `crop ends at or after the box: ${JSON.stringify(c)} for box ${JSON.stringify(box)}`);
  }
});

check("there is context around the subject, not a tight cut-out", () => {
  eq(CROP_PAD > 0, true, "the padding exists");
  const box = { x: 0.4, y: 0.4, w: 0.1, h: 0.2 };
  const c = planCrop(box, FRAME);
  eq(c.w > box.w * FRAME.width, true, `wider than the box: ${c.w} vs ${box.w * FRAME.width}`);
  eq(c.h > box.h * FRAME.height, true, "and taller");
});

check("THE FEARED ONE: a box at the very edge gets a whole thumbnail, not a sliver", () => {
  // The bottle sat at x = 0.0015. Padding it to the left runs off the frame;
  // the crop must SHIFT inwards and keep its size rather than be cut short.
  const box = { x: 0.0015, y: 0.3675, w: 0.2145, h: 0.6208 };
  const middle = planCrop({ x: 0.4, y: 0.1755, w: 0.2145, h: 0.6208 }, FRAME);
  const edge = planCrop(box, FRAME);
  eq(edge.x, 0, "it starts at the frame edge");
  eq(edge.w, middle.w, `and is just as wide as the same box in the middle: ${edge.w} vs ${middle.w}`);
  eq(inFrame(edge), true, "still inside the frame");
});

check("a tiny detection is still big enough to recognise", () => {
  eq(CROP_MIN_PX >= 64, true, `the floor is a usable size: ${CROP_MIN_PX}`);
  const speck = { x: 0.5, y: 0.5, w: 0.01, h: 0.02 };   // 26 x 29 px on this frame
  const c = planCrop(speck, FRAME);
  eq(c.w >= CROP_MIN_PX && c.h >= CROP_MIN_PX, true, `enlarged to ${c.w}x${c.h}`);
  eq(inFrame(c), true, "and still inside the frame");
});

check("a frame smaller than the minimum gives the whole frame rather than refusing", () => {
  const small = { width: 80, height: 60 };
  const c = planCrop({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, small);
  eq(isRefusal(c), false, "answered");
  eq([c.x, c.y, c.w, c.h], [0, 0, 80, 60], "the whole picture is the best crop available");
});

check("whole pixels only: ffmpeg cannot crop half a pixel", () => {
  const c = planCrop({ x: 0.1234567, y: 0.7654321, w: 0.0987654, h: 0.1357913 }, FRAME);
  for (const v of [c.x, c.y, c.w, c.h]) eq(Number.isInteger(v), true, `${v} is a whole number`);
});

check("THE FEARED ONE: a box that cannot be read is refused, never cropped to a guess", () => {
  for (const bad of [
    null, "nope", 42, {},
    { x: 0.1, y: 0.1, w: 0.1 },
    { x: NaN, y: 0.1, w: 0.1, h: 0.1 },
    { x: 0.1, y: 0.1, w: 0, h: 0.1 },
    { x: -0.5, y: 0.1, w: 0.1, h: 0.1 },
    { x: 0.1, y: 0.1, w: 2, h: 0.1 },
  ]) {
    const r = planCrop(bad, FRAME);
    eq(isRefusal(r), true, `refused ${JSON.stringify(bad)}`);
    eq(r.reason, "bad_box", "says why");
  }
});

check("a frame size that cannot be read is refused too", () => {
  for (const bad of [null, {}, { width: 0, height: 100 }, { width: 100, height: -1 }, { width: "2560", height: 1440 }]) {
    const r = planCrop({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, bad);
    eq(isRefusal(r), true, `refused frame ${JSON.stringify(bad)}`);
    eq(r.reason, "bad_frame", "says why");
  }
});

report("crop plan");
