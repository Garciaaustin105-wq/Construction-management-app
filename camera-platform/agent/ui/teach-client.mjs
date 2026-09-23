/**
 * Pure helpers for the teach list page (TEACH-LIST-SPEC.md piece 4). No DOM,
 * no fetch, no clock read: agent/ui/teach.html imports these and is left
 * with drawing and network calls only, the same split review-client.mjs
 * keeps for review.html (build rule 2).
 */

/**
 * "12 of 20 people, 25 of 60 quiet minutes in the answer key", from a GET
 * /teach-moments response's `library` (the same clipProgress() shape GET
 * /clip-library and the Review page already use).
 *
 * The targets (20 people, 60 minutes) are never repeated here as numbers:
 * personCount + personsStillNeeded IS the target, and the server already did
 * that arithmetic once in clipProgress(). Hardcoding MIN_GATE_PERSONS here
 * too would be a second place for it to drift out of step with
 * contracts/clipLibrary.ts if that gate ever changes.
 *
 * null when library does not look like clipProgress()'s own shape (an
 * error object, or a network body this page cannot trust) -- never a
 * fabricated "0 of 0".
 */
export function progressLine(library) {
  if (typeof library !== "object" || library === null) return null;
  const { personCount, personsStillNeeded, emptyMinutes, emptyMinutesStillNeeded } = library;
  if (
    ![personCount, personsStillNeeded, emptyMinutes, emptyMinutesStillNeeded].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  ) {
    return null;
  }
  const personTarget = personCount + personsStillNeeded;
  const emptyTarget = emptyMinutes + emptyMinutesStillNeeded;
  return (
    personCount + " of " + personTarget + " people, " +
    emptyMinutes + " of " + emptyTarget + " quiet minutes in the answer key"
  );
}

/** Local wall-clock "HH:MM" for a UTC ISO string -- the same rule review.html's own localTime uses. */
export function localTime(utc) {
  const d = new Date(utc);
  const two = (n) => String(n).padStart(2, "0");
  return two(d.getHours()) + ":" + two(d.getMinutes());
}

/** One line per kind, for the card's small header. */
export function momentTitle(kind) {
  if (kind === "moved_nothing_stored") return "Moved, nothing stored";
  if (kind === "person_stored") return "Person stored";
  if (kind === "quiet") return "Quiet";
  return "Moment";
}

/**
 * The plain measurement a card shows -- rule 11: report what was measured,
 * never a verdict. No wording here may claim a miss, a mistake or a failure;
 * that judgement is exactly the tap the person is about to make. "" when
 * `moment` does not carry the evidence its own kind requires -- never a
 * guessed number.
 */
export function momentText(moment) {
  if (typeof moment !== "object" || moment === null) return "";
  const ev = moment.evidence;
  if (typeof ev !== "object" || ev === null) return "";
  if (moment.kind === "moved_nothing_stored") {
    if (!Number.isFinite(ev.frames) || !Number.isFinite(ev.motionLooks)) return "";
    return "Motion looked at " + ev.motionLooks + " of " + ev.frames + " frame(s); nothing was stored.";
  }
  if (moment.kind === "person_stored") {
    if (!Number.isFinite(ev.bestConfidence) || !Number.isFinite(ev.sightings)) return "";
    const pct = Math.round(ev.bestConfidence * 100);
    const base = "A person was stored: " + pct + "% best confidence, " + ev.sightings + " sighting(s).";
    return ev.hidden === true ? base + " Marked as a known object." : base;
  }
  if (moment.kind === "quiet") {
    if (!Number.isFinite(ev.minutes)) return "";
    return ev.minutes + " quiet minute(s): gate data present, no motion, nothing stored.";
  }
  return "";
}

/** GET /still's own query for this moment's illustration. */
export function stillUrl(cameraId, stillAtUtc) {
  return "/still?" + new URLSearchParams({ camera: cameraId, at: stillAtUtc }).toString();
}

/**
 * A "Watch" link into Review at this moment's camera and instant.
 *
 * review.html does not read camera/at back off its own URL today -- adding
 * that is a change to review.html's own (large, separately owned) script,
 * out of this page's small addition there. Carried as query params anyway,
 * harmlessly ignored by today's Review, so a later Review change can pick
 * them up without this page changing again.
 */
export function watchUrl(cameraId, atUtc) {
  return "/review?" + new URLSearchParams({ camera: cameraId, at: atUtc }).toString();
}

/**
 * The body POST /clip-library needs for one answer (agent/clip-library.mjs):
 * cameraId, startUtc, endUtc, people, vehicles, scenes, all from the moment
 * itself plus the two counts the card collected.
 *
 * scenes follows checkLibrary's own rule (contracts/clipLibrary.ts): "empty"
 * only when expectedCount is 0 (nobody, no car), one of "person"/"vehicle"
 * (or both) whenever it is not -- never both, never neither, so this can
 * never build a body checkLibrary would refuse for its own scenes/expected
 * mismatch.
 */
export function saveBody(moment, people, carOn) {
  const vehicles = carOn ? 1 : 0;
  const scenes = [];
  if (people === 0 && vehicles === 0) {
    scenes.push("empty");
  } else {
    if (people > 0) scenes.push("person");
    if (vehicles > 0) scenes.push("vehicle");
  }
  return {
    cameraId: moment.cameraId,
    startUtc: moment.startUtc,
    endUtc: moment.endUtc,
    people,
    vehicles,
    scenes,
  };
}

/**
 * A legal exact count for the "3+" prompt. clip-library.mjs's own isCount
 * allows any whole 0-20; "3+" only ever asks for 3 and up, so the floor here
 * is 3, not 0 -- a smaller number belongs to its own dedicated button.
 */
export function isExactCount(n) {
  return Number.isInteger(n) && n >= 3 && n <= 20;
}

/** Plain-English refusal text for GET /teach-moments and GET /still's own codes. */
export function friendlyTeachProblem(code) {
  const mapping = {
    bad_camera_id: "That camera is not set up on this recorder.",
    bad_day: "Pick a day.",
    footage_gone: "The recording for that moment is no longer on this recorder.",
    segment_open: "That moment is still being recorded; try again shortly.",
    still_in_future: "That moment has not happened yet.",
    crop_failed: "The still could not be cut.",
    busy: "Too many stills are already being cut; try again shortly.",
    forbidden: "This account cannot see recorded footage.",
    unauthorized: "Sign in to see this page.",
  };
  return mapping[code] ?? "Cannot reach the recorder.";
}
