/**
 * Whether the drawn day should be asked for again
 * (agent/ui/review-client.mjs: refreshDecision).
 *
 * WHY THIS EXISTS. On 2026-09-20 a person walked up to the house and the
 * detector caught him twice, at 0.88 and 0.90 confidence, five seconds and
 * four seconds long. The Review page showed neither, because the page had
 * been opened before he arrived and loadDay() was wired only to page load and
 * to the camera and day dropdowns. Nothing ever asked again. A detector that
 * works and a page that never re-asks are indistinguishable from the outside,
 * and the second one is the one the customer reports.
 *
 * THE FEARED FAILURES, in the order they would hurt:
 * - a refresh fires while someone is watching a clip, redrawing the strip,
 *   dropping the playhead and forgetting which marker they had stepped to.
 *   That interrupts the exact job this product exists for, and it would be
 *   blamed on the video player, not on a timer;
 * - the page pins a day in the past or the future and re-asks for it forever,
 *   redrawing under the cursor for something that cannot change;
 * - a hidden tab keeps questioning a box that is running inference on every
 *   camera it holds;
 * - a clock step leaves the page waiting out the skew, looking frozen;
 * - it throws. This runs on a timer, so an exception here takes the page down
 *   between one event and the next - the worst possible moment.
 */
import { refreshDecision, REFRESH_INTERVAL_MS, followToday } from "../agent/ui/review-client.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("reviewRefresh");

const DAY_START = Date.parse("2026-09-20T04:00:00.000Z"); // local midnight
const DAY_END = DAY_START + 24 * 3600_000;
const MIDDAY = DAY_START + 12 * 3600_000;
/** A page that has been sitting open long enough to be due. */
const state = (over = {}) => ({
  nowMs: MIDDAY,
  lastLoadMs: MIDDAY - 10 * 60_000,
  dayStartMs: DAY_START,
  dayEndMs: DAY_END,
  clipOpen: false,
  hidden: false,
  ...over,
});

check("the interval is short enough that a person is not missed", () => {
  eq(REFRESH_INTERVAL_MS <= 30_000, true, `${REFRESH_INTERVAL_MS}ms: half a minute at worst`);
  eq(REFRESH_INTERVAL_MS >= 5_000, true, "and not a stampede");
});

check("THE ORIGINAL BUG: a page left open on today asks again", () => {
  const d = refreshDecision(state());
  eq(d.refresh, true, "it re-asks");
  eq(d.reason, "due", "and says why");
});

check("THE FEARED ONE: never while a clip is open", () => {
  // Someone reviewing an incident is doing the one job this product is for.
  // A stale count is survivable; losing their place is not.
  const d = refreshDecision(state({ clipOpen: true }));
  eq(d.refresh, false, "left alone");
  eq(d.reason, "clip_open", "and says so");
  // Not even after an hour, and not even on a page that has never loaded.
  eq(refreshDecision(state({ clipOpen: true, lastLoadMs: MIDDAY - 3600_000 })).refresh, false,
    "still not after an hour");
  eq(refreshDecision(state({ clipOpen: true, lastLoadMs: null })).refresh, false, "nor when never loaded");
});

check("nor while the save/export sheet is open", () => {
  // Choosing a range to hand to somebody else is mid-task too. The time
  // dropdowns do survive a redraw, which is why this is a separate, lesser
  // reason rather than being folded into clip_open and quietly mislabelled.
  const d = refreshDecision(state({ sheetOpen: true }));
  eq(d.refresh, false, "left alone");
  eq(d.reason, "sheet_open", "and says which of the two it was");
});

check("and it resumes the moment the clip is closed", () => {
  // The other half of the feared one: a refusal that never lifts is a page
  // that stops updating for good because someone once opened a clip.
  eq(refreshDecision(state({ clipOpen: false })).refresh, true, "back to asking");
});

check("a day that is over is never re-asked", () => {
  // Yesterday cannot gain events. Re-asking redraws under the cursor for
  // nothing.
  const d = refreshDecision(state({ nowMs: DAY_END + 1 }));
  eq(d.refresh, false, "left alone");
  eq(d.reason, "day_is_over", "and says why");
});

check("THE MIDNIGHT ONE: a page open across midnight stops refreshing itself", () => {
  // At 23:59 the drawn day is today and refreshes. One minute later the same
  // drawn day is history: new events land on the NEXT day, which this page is
  // not showing, so asking again would redraw the same bar forever.
  const beforeMidnight = state({ nowMs: DAY_END - 60_000, lastLoadMs: DAY_END - 3600_000 });
  eq(refreshDecision(beforeMidnight).refresh, true, "23:59 still refreshes");
  const afterMidnight = { ...beforeMidnight, nowMs: DAY_END + 60_000 };
  eq(refreshDecision(afterMidnight).refresh, false, "00:01 does not");
  eq(refreshDecision(afterMidnight).reason, "day_is_over",
    "because the drawn day is over, not because anything broke");
});

check("a day that has not happened yet is never re-asked", () => {
  const d = refreshDecision(state({ nowMs: DAY_START - 1 }));
  eq(d.refresh, false, "left alone");
  eq(d.reason, "day_not_started", "and says why");
});

check("a hidden tab does not question a box that is running inference", () => {
  const d = refreshDecision(state({ hidden: true }));
  eq(d.refresh, false, "quiet");
  eq(d.reason, "hidden", "and says why");
});

check("it does not ask faster than the interval", () => {
  const justAsked = state({ lastLoadMs: MIDDAY - 1000 });
  eq(refreshDecision(justAsked).refresh, false, "a second ago is too soon");
  eq(refreshDecision(justAsked).reason, "too_soon", "and says why");
  // The boundary, stated rather than left to chance.
  eq(refreshDecision(state({ lastLoadMs: MIDDAY - REFRESH_INTERVAL_MS + 1 })).refresh, false,
    "one ms short: no");
  eq(refreshDecision(state({ lastLoadMs: MIDDAY - REFRESH_INTERVAL_MS })).refresh, true,
    "exactly the interval: yes");
});

check("a page that has never loaded asks straight away", () => {
  for (const missing of [null, undefined, NaN, "never"]) {
    const d = refreshDecision(state({ lastLoadMs: missing }));
    eq(d.refresh, true, `asks when lastLoadMs is ${String(missing)}`);
    eq(d.reason, "never_loaded", "and says why");
  }
});

check("THE FROZEN ONE: a clock step does not strand the page", () => {
  // A laptop waking, or NTP stepping the box, can stamp a load in the future.
  // Naive arithmetic gives a negative age, which is forever "too soon", and
  // the page looks broken for as long as the skew lasts.
  const d = refreshDecision(state({ lastLoadMs: MIDDAY + 6 * 3600_000 }));
  eq(d.refresh, true, "asks anyway");
  eq(d.reason, "clock_moved", "and names the cause, so it is not mistaken for a bug here");
});

check("it never throws, whatever it is handed", () => {
  // This runs on a timer. An exception takes the page down between one event
  // and the next.
  const rubbish = [null, undefined, 0, "", "today", [], [1, 2], true, NaN,
    {}, { nowMs: "now" }, { nowMs: MIDDAY }, state({ nowMs: Infinity }),
    state({ dayStartMs: DAY_END, dayEndMs: DAY_START }), state({ dayEndMs: DAY_START }),
    state({ intervalMs: NaN }), Object.create(null)];
  for (const [i, bad] of rubbish.entries()) {
    // Labelled by position, not by String(bad): a null-prototype object throws
    // on its own conversion, which would fail this check for a reason that has
    // nothing to do with the code under test. It cost a red line to learn.
    let d;
    let threw = false;
    try { d = refreshDecision(bad); } catch { threw = true; }
    eq(threw, false, `survived rubbish #${i}`);
    eq(typeof d === "object" && d !== null && typeof d.refresh === "boolean", true,
      "and still answers with a decision");
  }
});

check("unreadable state refuses rather than guessing", () => {
  // Rule 10: refuse rather than guess when a wrong answer would look
  // plausible. A refresh on rubbish input is not obviously wrong, which is
  // exactly why it must not happen.
  eq(refreshDecision(null).reason, "unreadable", "no state");
  eq(refreshDecision({ ...state(), nowMs: "midday" }).reason, "unreadable", "a clock that is not a number");
  eq(refreshDecision({ ...state(), dayEndMs: DAY_START }).reason, "unreadable", "a day window of no width");
  eq(refreshDecision(null).refresh, false, "and refuses");
});

check("it states no verdict about what it found", () => {
  // Rule 11: report measurements, do not render verdicts. This decides when
  // to ask a question, and nothing else.
  const d = refreshDecision(state());
  eq(Object.keys(d).sort(), ["reason", "refresh"], "a decision and its reason, nothing more");
});

/* ── following today across midnight (followToday) ─────────────────────── */

// Austin, 2026-09-21: "make it jump to the new day at midnight". A page left
// open on today used to go quiet on what had become yesterday.
const follow = (over = {}) => followToday({
  drawnDay: "2026-09-21", followDay: "2026-09-21", today: "2026-09-22",
  clipOpen: false, sheetOpen: false, pickingDay: false, hidden: false, ...over,
});

check("THE MIDNIGHT ONE: a page left on today moves to the new today", () => {
  const d = follow();
  eq(d.move, true, "it moves");
  eq(d.toDay, "2026-09-22", "to the new today");
  eq(d.reason, "new_day", "and says why");
});

check("THE FEARED ONE: a day picked on purpose is never taken away", () => {
  // Someone reviewing Saturday's footage at midnight is not following today.
  const d = follow({ drawnDay: "2026-09-19", followDay: "2026-09-21" });
  eq(d.move, false, "left alone");
  eq(d.reason, "not_following", "because it was not the day being followed");
  eq(follow({ followDay: null }).move, false, "and a page that never saw today follows nothing");
});

check("it waits rather than move the ground under someone", () => {
  for (const [key, reason] of [["clipOpen", "clip_open"], ["sheetOpen", "sheet_open"],
    ["pickingDay", "picking_day"], ["hidden", "hidden"]]) {
    const d = follow({ [key]: true });
    eq(d.move, false, `not while ${key}`);
    eq(d.reason, reason, "and says which");
  }
  eq(follow().move, true, "and moves once nothing is in the way");
});

check("a page asleep for days goes straight to today", () => {
  const d = follow({ today: "2026-09-25" });
  eq(d.toDay, "2026-09-25", "not through the days between");
});

check("a clock stepped back is not a new day", () => {
  const d = follow({ today: "2026-09-20" });
  eq(d.move, false, "no move backwards");
  eq(d.reason, "clock_behind", "and it says so");
});

check("a page already on today stays put", () => {
  eq(follow({ drawnDay: "2026-09-22", followDay: "2026-09-22" }).reason, "already_today", "nothing to do");
});

check("followToday never throws, and never moves on what it cannot read", () => {
  const rubbish = [null, undefined, 0, "x", [], {}, { drawnDay: "2026-09-21" },
    { drawnDay: 20260921, followDay: 20260921, today: "2026-09-22" },
    { drawnDay: "21/09/2026", followDay: "21/09/2026", today: "22/09/2026" }, Object.create(null)];
  for (const [i, bad] of rubbish.entries()) {
    let d;
    let threw = false;
    try { d = followToday(bad); } catch { threw = true; }
    eq(threw, false, `survived rubbish #${i}`);
    eq(d?.move, false, `and did not move for #${i}`);
  }
});

report("reviewRefresh");
