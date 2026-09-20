/**
 * D2: what /events accepts (contracts/eventQuery.ts).
 *
 * THE FEARED FAILURES: a filter the server does not understand quietly
 * answering "no events", so a person who IS in the footage looks absent; a
 * day with thousands of events answered with the first few and no word that
 * the rest exist; a limit that lets one request read the whole table.
 */
import { parseEventKinds, parseEventLimit, EVENT_LIMIT_DEFAULT, EVENT_LIMIT_MAX } from "../dist/eventQuery.js";
import { EVENT_KINDS } from "../dist/detection.js";
import { check, eq, report } from "./_assert.mjs";

console.log("event query");

const isRefusal = (r) => r !== null && typeof r === "object" && r.ok === false;

check("no filter means every kind, and the caller cannot tell the difference later", () => {
  eq(parseEventKinds(null), [...EVENT_KINDS], "absent");
  eq(parseEventKinds(""), [...EVENT_KINDS], "blank");
  eq(parseEventKinds("   "), [...EVENT_KINDS], "spaces");
});

check("a filter keeps the caller's kinds, de-duplicated, in the contract's order", () => {
  eq(parseEventKinds("person"), ["person"], "one");
  eq(parseEventKinds("vehicle,person"), ["person", "vehicle"], "two, in EVENT_KINDS order");
  eq(parseEventKinds("person, person ,vehicle"), ["person", "vehicle"], "spaces and repeats");
});

check("THE FEARED ONE: a kind the server does not know is refused, never answered as 'nothing found'", () => {
  for (const bad of ["dog", "person,dog", "PERSON", "", ","].slice(0, 3).concat([",", "person,,vehicle"])) {
    const r = parseEventKinds(bad === "" ? "x" : bad);
    if (!isRefusal(r)) throw new Error(`${JSON.stringify(bad)} was accepted as ${JSON.stringify(r)}`);
    eq(r.status, 400, "400");
    eq(r.code, "bad_kind", "code");
    if (!r.message.includes("person")) throw new Error(`the refusal should say what is allowed: ${r.message}`);
  }
  eq(isRefusal(parseEventKinds(["person"])), true, "not a string at all");
  eq(isRefusal(parseEventKinds(7)), true, "a number");
});

check("the limit defaults, caps, and refuses anything that is not a plain count", () => {
  eq(parseEventLimit(null), EVENT_LIMIT_DEFAULT, "absent");
  eq(parseEventLimit(""), EVENT_LIMIT_DEFAULT, "blank");
  eq(parseEventLimit("50"), 50, "a number");
  eq(parseEventLimit(String(EVENT_LIMIT_MAX)), EVENT_LIMIT_MAX, "at the cap");
  eq([EVENT_LIMIT_DEFAULT, EVENT_LIMIT_MAX], [500, 5000], "the numbers themselves");
  for (const bad of ["0", "-1", "1.5", "all", "1e3", String(EVENT_LIMIT_MAX + 1), " 10"]) {
    const r = parseEventLimit(bad);
    if (!isRefusal(r)) throw new Error(`${JSON.stringify(bad)} was accepted as ${JSON.stringify(r)}`);
    eq([r.status, r.code], [400, "bad_limit"], `refused: ${bad}`);
  }
});

report("event query");
