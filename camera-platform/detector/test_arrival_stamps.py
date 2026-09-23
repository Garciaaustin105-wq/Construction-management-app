"""Checks for yolox_worker's arrival-time pairing: matching a frame read from
ffmpeg's stdout, by sequential index, to the wall-clock arrival time ffmpeg's
showinfo filter reported for that same output frame on stderr. Run by
harness/arrivalStamps.harness.mjs, which skips loudly without a bare `python`
(no numpy needed - none of this touches a frame's pixels).

THE FEARED FAILURES, each one a wrong or missing atUtc that looks fine:
  - trusting showinfo's own `pts_time` text, which at a ~1.79e9 s Unix epoch
    ffmpeg prints with six significant figures - a confident, plausible,
    WRONG time good to about 1000 s (measured on the box, ffmpeg 6.1.1,
    2026-09-23: see REAL_SHOWINFO_LINES below);
  - a missing, late or garbled stderr line taking down more than the one
    frame it belongs to, or silently reusing a stale pairing;
  - stdout and stderr arriving out of order, or a stderr line arriving twice,
    breaking the index it lands on for every frame after it;
  - a worker that waits forever for a line that will never come;
  - a MANUFACTURED "arrival" time: a duplicated frame (once produced by the
    fps= filter's own constant-frame-rate padding, an adversarial review
    found and this file now guards against - see the "duplicate" checks
    below) stamped with an invented time that looks exactly as real as one
    that came from an actual packet arriving;
  - the stderr-reading thread dying silently while ffmpeg keeps running,
    after which every frame would degrade to timeSource "read" forever with
    nothing in the logs to explain why (see the stderr_reader_dead checks).
"""
import sys
import threading
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])
import yolox_worker as w  # noqa: E402

failures = []
total = 0


def check(name, fn):
    global total
    total += 1
    try:
        fn()
        print(f"  ok   {name}")
    except AssertionError as e:
        failures.append(name)
        print(f"  FAIL {name}\n       {e}")


def eq(got, want, what):
    assert got == want, f"{what}: expected {want!r}, got {got!r}"


# Captured verbatim on the box (ausitn-garcia-ROG-Zephyrus-G14, ffmpeg
# 6.1.1-3ubuntu5), replaying a real recorded cam2-sub segment through this
# worker's exact ffmpeg arguments (-use_wallclock_as_timestamps 1 -copyts,
# showinfo last in the filter chain), 2026-09-23. Includes ffmpeg's own
# progress-stats line (ending \r, no newline) landing immediately before a
# showinfo line on the same read - readline() still hands back one complete
# line here, but the parser must not care that there is leading junk before
# the part it wants. NOTE: these lines were captured through the OLD fps=
# filter chain (the one this fix replaces) - frames 0, 1 and 2 at fps 5 all
# carry the SAME checksum, 8F5F093D, which is exactly the HIGH finding this
# fix addresses (fps='s duplicate-on-stall behaviour) caught in the wild; they
# still make a faithful fixture for the PARSING and duplicate-FLAGGING logic
# checked here, which does not care which filter produced the line.
REAL_SHOWINFO_LINES = {
    "time_base_fps5": "[Parsed_showinfo_3 @ 0x63098ec917c0] config in time_base: 1/5, frame_rate: 5/1",
    "time_base_fps8": "[Parsed_showinfo_3 @ 0x612eecafb9c0] config in time_base: 1/8, frame_rate: 8/1",
    "config_out": "[Parsed_showinfo_3 @ 0x612eecafb9c0] config out time_base: 0/0, frame_rate: 0/0",
    "frame0_fps5": "[Parsed_showinfo_3 @ 0x63098ec917c0] n:   0 pts:8950911186 pts_time:1.79018e+09 duration:      1 duration_time:0.2     fmt:bgr24 cl:left sar:0/1 s:640x640 i:P iskey:0 type:P checksum:8F5F093D plane_checksum:[8F5F093D] mean:[106] stdev:[47.0]",
    "frame1_after_progress": "frame=    0 fps=0.0 q=0.0 size=       0kB time=N/A bitrate=N/A speed=N/A    \r[Parsed_showinfo_3 @ 0x63098ec917c0] n:   1 pts:8950911187 pts_time:1.79018e+09 duration:      1 duration_time:0.2     fmt:bgr24 cl:left sar:0/1 s:640x640 i:P iskey:0 type:P checksum:8F5F093D plane_checksum:[8F5F093D] mean:[106] stdev:[47.0]",
    "frame2_fps5": "[Parsed_showinfo_3 @ 0x63098ec917c0] n:   2 pts:8950911188 pts_time:1.79018e+09 duration:      1 duration_time:0.2     fmt:bgr24 cl:left sar:0/1 s:640x640 i:P iskey:0 type:P checksum:8F5F093D plane_checksum:[8F5F093D] mean:[106] stdev:[47.0]",
    "frame0_fps8": "[Parsed_showinfo_3 @ 0x612eecafb9c0] n:   0 pts:14321459011 pts_time:1.79018e+09 duration:      1 duration_time:0.125   fmt:bgr24 cl:left sar:0/1 s:640x640 i:P iskey:0 type:P checksum:8F5F093D plane_checksum:[8F5F093D] mean:[106] stdev:[47.0]",
    "frame1_fps8": "[Parsed_showinfo_3 @ 0x612eecafb9c0] n:   1 pts:14321459012 pts_time:1.79018e+09 duration:      1 duration_time:0.125   fmt:bgr24 cl:left sar:0/1 s:640x640 i:P iskey:0 type:P checksum:BC41BAE7 plane_checksum:[BC41BAE7] mean:[99] stdev:[51.8]",
}

print("arrival stamps")

# ---------------- parsing real captured lines ----------------

check("THE FEARED ONE: showinfo's own pts_time text is not trusted - six significant figures at a ~1.79e9 s epoch would be off by up to ~1000 s, a wrong time that looks exactly as plausible as a right one", lambda: (
    eq("1.79018e+09" in REAL_SHOWINFO_LINES["frame0_fps5"], True, "the real line really does carry the lossy field"),
    eq(w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame0_fps5"]), (0, 8950911186, "8F5F093D"), "the raw integer pts is read instead, in full, alongside the content checksum"),
))

check("the real config line is read for its exact time_base, fps 5 and fps 8 both measured on the box", lambda: (
    eq(w.parse_showinfo_time_base(REAL_SHOWINFO_LINES["time_base_fps5"]), (1, 5), "fps 5"),
    eq(w.parse_showinfo_time_base(REAL_SHOWINFO_LINES["time_base_fps8"]), (1, 8), "fps 8"),
    # showinfo also prints a second, real "config OUT time_base: 0/0" line
    # (the filter's output link, before it is negotiated) - the "in" line is
    # the one this worker reads, and "out" must not be mistaken for it.
    eq(w.parse_showinfo_time_base(REAL_SHOWINFO_LINES["config_out"]), None, "the real 'config out ...: 0/0' line is not mistaken for 'config in'"),
))

check("real per-frame lines parse to (n, raw pts, checksum), fps 5", lambda: (
    eq(w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame0_fps5"]), (0, 8950911186, "8F5F093D"), "frame 0"),
    eq(w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame2_fps5"]), (2, 8950911188, "8F5F093D"), "frame 2"),
))

check("a showinfo line landing right after ffmpeg's own \\r progress stats, on one readline(), still parses", lambda: (
    eq(w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame1_after_progress"]), (1, 8950911187, "8F5F093D"), "the showinfo part is found regardless of what came before it on the line"),
))

check("real per-frame lines parse to (n, raw pts, checksum), fps 8 - proving the pairing does not hardcode fps 5, and these two really do carry DIFFERENT checksums", lambda: (
    eq(w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame0_fps8"]), (0, 14321459011, "8F5F093D"), "frame 0"),
    eq(w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame1_fps8"]), (1, 14321459012, "BC41BAE7"), "frame 1"),
))

check("a showinfo-shaped line with no checksum field still parses - the pts pairing must not depend on the checksum being available", lambda: (
    eq(w.parse_showinfo_frame("n:   7 pts:12345 pts_time:0"), (7, 12345, None), "n and pts found, checksum None rather than a match failure"),
))

check("end to end: a real config line plus a real frame line reconstruct the exact arrival second", lambda: (
    (lambda p: (
        p.learn_time_base(*w.parse_showinfo_time_base(REAL_SHOWINFO_LINES["time_base_fps5"])),
        p.offer(*w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame0_fps5"])),
        eq(p.take(0), (8950911186 / 5, False), "pts / fps, to the bit - not showinfo's own rounded pts_time; not a duplicate, it is the first frame offered"),
    ))(w.PtsPairer()),
))

# ---------------- garbage, partial and unrelated lines ----------------

check("THE FEARED ONE: lines that are not a showinfo report never raise and never match", lambda: (
    eq(w.parse_showinfo_frame(""), None, "empty"),
    eq(w.parse_showinfo_frame("Input #0, rtsp, from 'rtsp://user:pass@host/path':"), None, "ffmpeg's own banner - and note: nothing here is ever printed from it"),
    eq(w.parse_showinfo_frame("[graph 0 input from stream 0:0 @ 0x1] w:640 h:360"), None, "a different filter's info line"),
    eq(w.parse_showinfo_frame("n: pts:"), None, "the labels with no numbers - a line torn mid-write"),
    eq(w.parse_showinfo_frame("n:   3 pts:not_a_number pts_time:1.0"), None, "a non-numeric pts - never seen from real ffmpeg, not trusted anyway"),
    eq(w.parse_showinfo_frame(None), None, "not a string at all"),
    eq(w.parse_showinfo_frame(12345), None, "not a string at all (int)"),
    eq(w.parse_showinfo_time_base("config in time_base: 1/0"), None, "a zero denominator is refused, never divided by"),
    eq(w.parse_showinfo_time_base("config in time_base: 0/5"), None, "a zero numerator (would silently make every arrival stamp read as epoch 0)"),
    eq(w.parse_showinfo_time_base("config in time_base: -1/5"), None, "a negative numerator"),
    eq(w.parse_showinfo_time_base(""), None, "empty"),
))

# ---------------- PtsPairer: pure pairing logic ----------------

def pairer_with(fps5=True):
    p = w.PtsPairer()
    if fps5:
        p.learn_time_base(1, 5)
    return p


check("frames are paired by index: two different frames offered, each taken by its own n", lambda: (
    (lambda p: (
        p.offer(0, 100),
        p.offer(1, 105),
        eq(p.take(1), (105 / 5, False), "frame 1, not frame 0"),
        eq(p.take(0), (100 / 5, False), "frame 0, still there after frame 1 was taken"),
    ))(pairer_with()),
))

check("take() forgets: asking twice gets nothing the second time", lambda: (
    (lambda p: (
        p.offer(0, 100),
        p.take(0),
        eq(p.take(0), (None, False), "already taken"),
    ))(pairer_with()),
))

check("THE FEARED ONE: a missing showinfo line falls back cleanly for that frame only, and the next frame still pairs", lambda: (
    (lambda p: (
        p.offer(0, 100),
        # frame 1's line never arrives at all
        p.offer(2, 110),
        eq(p.take(0), (100 / 5, False), "frame 0 pairs"),
        eq(p.take(1), (None, False), "frame 1 has nothing - falls back, and nothing raises"),
        eq(p.take(2), (110 / 5, False), "frame 2 pairs correctly right after the gap"),
    ))(pairer_with()),
))

check("THE FEARED ONE: a garbled line (unparseable) leaves that frame alone and nothing else", lambda: (
    (lambda p: (
        p.offer(0, 100),
        None if w.parse_showinfo_frame("n:   1 pts:garbage") is None else p.offer(1, 999),  # the garbled line for frame 1 never reaches offer()
        p.offer(2, 110),
        eq(p.take(0), (100 / 5, False), "frame 0 fine"),
        eq(p.take(1), (None, False), "frame 1's garbled line never made it in - falls back"),
        eq(p.take(2), (110 / 5, False), "frame 2 fine, right after"),
    ))(pairer_with()),
))

check("out-of-order stderr lines still pair correctly: frame 2's line arrives before frame 1's", lambda: (
    (lambda p: (
        p.offer(0, 100),
        p.offer(2, 110),
        p.offer(1, 105),  # arrives last, out of order
        eq(p.take(0), (100 / 5, False), "0"),
        eq(p.take(1), (105 / 5, False), "1, offered last but still found by its own index"),
        eq(p.take(2), (110 / 5, False), "2, offered before 1 but still correct"),
    ))(pairer_with()),
))

check("duplicated stderr lines for the same frame do not raise, and the frame still pairs", lambda: (
    (lambda p: (
        p.offer(0, 100),
        p.offer(0, 100),  # ffmpeg reporting the same frame twice, verbatim
        eq(p.take(0), (100 / 5, False), "one pairing, not an error"),
    ))(pairer_with()),
))

check("a duplicate line with a DIFFERENT pts for the same index is not averaged or guessed at - the newest offer simply wins, never a blend", lambda: (
    (lambda p: (
        p.offer(5, 100),
        p.offer(5, 300),
        eq(p.take(5), (300 / 5, False), "last write wins - not (100+300)/2, never a blend of two readings"),
    ))(pairer_with()),
))

check("THE FEARED ONE: learn_time_base() refuses a zero or negative num/den itself, not only via the regex that normally feeds it - a wrong time_base would put every arrival stamp on this camera at the wrong moment, or divide by zero", lambda: (
    (lambda p: (
        p.learn_time_base(0, 5),
        eq(p.time_base, None, "a zero numerator is refused"),
        p.learn_time_base(1, 0),
        eq(p.time_base, None, "a zero denominator is refused (this would raise ZeroDivisionError in _seconds if it were not)"),
        p.learn_time_base(-1, 5),
        eq(p.time_base, None, "a negative numerator is refused"),
        p.learn_time_base(1, 5),
        eq(p.time_base, (1, 5), "a genuinely valid one is still accepted"),
    ))(w.PtsPairer()),
))

check("without a learned time_base, every offered frame is still unresolved - never guessed as 1/fps", lambda: (
    (lambda p: (
        p.offer(0, 100),
        eq(p.time_base, None, "nothing has taught it a time_base"),
        eq(p.take(0), (None, False), "so it will not manufacture a second from a raw pts it cannot interpret"),
    ))(w.PtsPairer()),
))

check("learning the time_base AFTER a frame was offered still lets that frame resolve, as long as it has not been evicted", lambda: (
    (lambda p: (
        p.offer(0, 100),
        p.learn_time_base(1, 5),
        eq(p.take(0), (100 / 5, False), "resolved once the time_base arrived, even though the frame arrived first"),
    ))(w.PtsPairer()),
))

check("peek() reads without forgetting; take() after peek() still returns the same paired value", lambda: (
    (lambda p: (
        p.offer(3, 100),
        eq(p.peek(3), 100 / 5, "peek sees it"),
        eq(p.peek(3), 100 / 5, "peek again: still there"),
        eq(p.take(3), (100 / 5, False), "take gets the same value, plus the duplicate flag"),
        eq(p.take(3), (None, False), "and now it is gone"),
    ))(pairer_with()),
))

check("discard() forgets a frame without anyone reading it, same as take() but with no return value read", lambda: (
    (lambda p: (
        p.offer(1, 100),
        p.discard(1),
        eq(p.take(1), (None, False), "gone"),
    ))(pairer_with()),
))

def bounded_memory():
    # A worker that runs for days must not grow this dict forever for frames
    # the gate skipped (whose showinfo lines still arrive, but are never
    # taken - see yolox_worker.main(), which only calls wait_for for a frame
    # it is actually going to report).
    p = pairer_with()
    for n in range(10_000):
        p.offer(n, n * 5)  # pts such that pts/5 == n, for a readable assertion below
    eq(len(p._raw) <= w.PtsPairer.EVICT_HORIZON + 1, True, f"bounded: {len(p._raw)} entries after 10,000 offers, horizon {w.PtsPairer.EVICT_HORIZON}")
    eq(p.take(9_999), (9_999, False), "the newest frame is still there")
    eq(p.take(0), (None, False), "the oldest is long gone")
check("PtsPairer stays bounded across a long run even when nothing ever takes an old frame", bounded_memory)


# ---------------- PtsPairer: duplicate-checksum flagging (the HIGH fix's backstop) ----------------

check("consecutive frames with the SAME checksum: the second is flagged a duplicate, never the first", lambda: (
    (lambda p: (
        p.offer(0, 100, "AAAA1111"),
        p.offer(1, 105, "AAAA1111"),
        eq(p.take(0), (100 / 5, False), "the first sighting of a checksum is never itself a duplicate - there is nothing before it to repeat"),
        eq(p.take(1), (105 / 5, True), "same checksum as the frame right before it - flagged"),
    ))(pairer_with()),
))

check("consecutive frames with DIFFERENT checksums: neither is flagged", lambda: (
    (lambda p: (
        p.offer(0, 100, "AAAA1111"),
        p.offer(1, 105, "BBBB2222"),
        eq(p.take(0), (100 / 5, False), "first"),
        eq(p.take(1), (105 / 5, False), "genuinely different content, not a duplicate"),
    ))(pairer_with()),
))

check("three in a row with the same checksum: the second and third are flagged, not the first", lambda: (
    (lambda p: (
        p.offer(0, 100, "CCCC3333"),
        p.offer(1, 105, "CCCC3333"),
        p.offer(2, 110, "CCCC3333"),
        eq(p.take(0), (100 / 5, False), "opens the run"),
        eq(p.take(1), (105 / 5, True), "repeats frame 0's content"),
        eq(p.take(2), (110 / 5, True), "repeats frame 1's content too"),
    ))(pairer_with()),
))

check("an offer with no checksum at all is never flagged, and does not reset what the NEXT offer is compared against", lambda: (
    (lambda p: (
        p.offer(0, 100, "DDDD4444"),
        p.offer(1, 105),  # no checksum offered this time - e.g. a line the optional group missed
        p.offer(2, 110, "DDDD4444"),
        eq(p.take(0), (100 / 5, False), "opens"),
        eq(p.take(1), (105 / 5, False), "no checksum offered - cannot be flagged either way"),
        eq(p.take(2), (110 / 5, True), "still compared against frame 0's checksum, the last REAL one seen - frame 1's checksum-less offer is skipped over, not treated as a mismatch that would hide a real duplicate"),
    ))(pairer_with()),
))

check("the duplicate flag is fixed at offer() time and survives regardless of the order frames are later taken in", lambda: (
    (lambda p: (
        p.offer(0, 100, "EEEE5555"),
        p.offer(1, 105, "EEEE5555"),  # duplicate of 0
        p.offer(2, 110, "FFFF6666"),  # not a duplicate of 1
        eq(p.take(2), (110 / 5, False), "taken first, out of index order - still correctly not a duplicate"),
        eq(p.take(1), (105 / 5, True), "still correctly flagged, unaffected by frame 2 being taken first"),
    ))(pairer_with()),
))

check("real captured lines: fps 5's frames 0 and 1 genuinely share a checksum on the box and are flagged; fps 8's frames 0 and 1 do not and are not", lambda: (
    (lambda p: (
        p.offer(*w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame0_fps5"])),
        p.offer(*w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame1_after_progress"])),
        eq(p.take(0)[1], False, "frame 0 opens the run"),
        eq(p.take(1)[1], True, "frame 1's checksum matches frame 0's, captured verbatim on the box"),
    ))(pairer_with()),
))

check("real captured lines at fps 8 carry genuinely different checksums and are not flagged", lambda: (
    (lambda p: (
        p.offer(*w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame0_fps8"])),
        p.offer(*w.parse_showinfo_frame(REAL_SHOWINFO_LINES["frame1_fps8"])),
        eq(p.take(0)[1], False, "frame 0"),
        eq(p.take(1)[1], False, "genuinely distinct content, fps does not matter to this logic"),
    ))(pairer_with(fps5=False)),
))


# ---------------- ArrivalStamps: the threaded wrapper ----------------

check("offer_line() routes a real config line and a real frame line to the right place, through one entry point", lambda: (
    (lambda s: (
        s.offer_line(REAL_SHOWINFO_LINES["time_base_fps5"]),
        s.offer_line(REAL_SHOWINFO_LINES["frame0_fps5"]),
        eq(s._pairer.peek(0), 8950911186 / 5, "reached the pairer through offer_line, not called on it directly"),
    ))(w.ArrivalStamps()),
))

check("offer_line() on an unrelated or garbled line changes nothing and never raises", lambda: (
    (lambda s: (
        s.offer_line("Input #0, rtsp, from 'rtsp://user:pass@host/path':"),
        s.offer_line("n:  pts:"),
        s.offer_line(""),
        eq(s._pairer.peek(0), None, "nothing was learned"),
    ))(w.ArrivalStamps()),
))

def wait_for_returns_once_offered():
    s = w.ArrivalStamps()
    s.offer_line(REAL_SHOWINFO_LINES["time_base_fps5"])
    s.offer_line(REAL_SHOWINFO_LINES["frame0_fps5"])
    got = s.wait_for(0, 1.0)
    eq(got, (8950911186 / 5, False), "already there: returns immediately with the right value, not a duplicate (nothing offered before it)")
check("wait_for() returns at once when the line already arrived", wait_for_returns_once_offered)


def wait_for_blocks_then_wakes():
    # THE FEARED ONE: the pairing must not miss a line that is genuinely on
    # its way, only late - a wait that gave up too early would fall back to
    # "read" even when "arrival" was one line away.
    s = w.ArrivalStamps()
    s.offer_line(REAL_SHOWINFO_LINES["time_base_fps5"])

    def deliver_late():
        time.sleep(0.15)
        s.offer_line(REAL_SHOWINFO_LINES["frame0_fps5"])

    t0 = time.monotonic()
    threading.Thread(target=deliver_late, daemon=True).start()
    got = s.wait_for(0, timeout_s=2.0)
    elapsed = time.monotonic() - t0
    eq(got, (8950911186 / 5, False), "found the line that arrived while waiting")
    eq(elapsed < 1.0, True, f"woke as soon as it arrived, not after the full 2 s bound: {elapsed:.3f}s")
check("wait_for() wakes up as soon as a late line arrives, rather than sleeping out the whole bound", wait_for_blocks_then_wakes)


def wait_for_gives_up_bounded():
    # THE FEARED ONE, the worker's whole safety net: a line that never
    # arrives must not hang the worker. Bounded, then (None, False) - the
    # caller falls back to the read-time stamp.
    s = w.ArrivalStamps()
    s.offer_line(REAL_SHOWINFO_LINES["time_base_fps5"])
    t0 = time.monotonic()
    got = s.wait_for(0, timeout_s=0.2)
    elapsed = time.monotonic() - t0
    eq(got, (None, False), "nothing ever arrived for frame 0")
    eq(0.2 <= elapsed < 1.0, True, f"waited close to the bound, not forever: {elapsed:.3f}s")
check("wait_for() gives up within its bound when the line never arrives - the worker never hangs on a lost stderr line", wait_for_gives_up_bounded)


def wait_for_does_not_wait_when_time_base_unknown_forever():
    # A more contrived case than production should ever reach (the config
    # line reliably comes first), included because it is the one place a
    # silent wrong guess (assuming 1/fps) would have been tempting: without a
    # learned time_base a frame simply never resolves, however long the
    # worker waits - proving the code does not fall back to guessing the
    # time_base instead of the read-time stamp.
    s = w.ArrivalStamps()
    s.offer_line(REAL_SHOWINFO_LINES["frame0_fps5"])  # no config line offered, ever
    got = s.wait_for(0, timeout_s=0.15)
    eq(got, (None, False), "a raw pts with no known time_base still resolves to nothing, not a guessed second")
check("without ever learning a time_base, wait_for never manufactures a second from a bare pts", wait_for_does_not_wait_when_time_base_unknown_forever)


def concurrent_offers_and_waits_stay_correct():
    # Many frames' lines delivered by a background thread while the "main
    # loop" waits for each one in turn, as yolox_worker.main() actually runs
    # it (one stderr-reading thread, one frame-reading loop). None of these
    # synthetic lines carry a checksum field, exercising the optional group
    # under real concurrent load too.
    s = w.ArrivalStamps()
    s.offer_line(REAL_SHOWINFO_LINES["time_base_fps5"])
    N = 200

    def deliver():
        for n in range(N):
            time.sleep(0.001)
            s.offer_line(f"[x] n: {n} pts:{n * 5} pts_time:0")

    threading.Thread(target=deliver, daemon=True).start()
    results = [s.wait_for(n, timeout_s=1.0) for n in range(N)]
    eq(results, [(float(n), False) for n in range(N)], "every frame paired to the right second, none skipped, none swapped, none flagged (no checksums offered)")
check("concurrent delivery and waiting across many frames: each index gets its own value, in order", concurrent_offers_and_waits_stay_correct)


def offer_line_flags_duplicate_end_to_end():
    # The same duplicate-checksum scenario as the PtsPairer-level checks
    # above, but through offer_line()/wait_for() exactly as _drain_stderr and
    # main() actually call them - proving the flag survives the threaded
    # glue, not just the pure pairer underneath it.
    s = w.ArrivalStamps()
    s.offer_line(REAL_SHOWINFO_LINES["time_base_fps5"])
    s.offer_line(REAL_SHOWINFO_LINES["frame0_fps5"])
    s.offer_line(REAL_SHOWINFO_LINES["frame1_after_progress"])
    seconds0, dup0 = s.wait_for(0, 1.0)
    seconds1, dup1 = s.wait_for(1, 1.0)
    eq(dup0, False, "frame 0 opens the run")
    eq(dup1, True, "frame 1 repeats frame 0's real, captured checksum")
    eq(seconds1, 8950911187 / 5, "still paired to its OWN real pts even though flagged - this layer stays honest about what arrived; main() is what decides to refuse calling it \"arrival\"")
check("offer_line() end to end: a real repeated checksum is flagged all the way through wait_for()", offer_line_flags_duplicate_end_to_end)


# ---------------- resolve_time_source: the exact HIGH-finding decision ----------------

READ_S = 1790187352.8  # 2026-09-23T18:15:52.8Z, the first good frame after the bench restart

check("THE FEARED ONE: a real pairing that is ALSO flagged a duplicate is refused as \"arrival\" - this is the exact decision the HIGH finding was about", lambda: (
    eq(w.resolve_time_source(READ_S - 1.0, True, READ_S), "read", "a duplicate must never win \"arrival\", however clean its pairing"),
))

check("a real, non-duplicate pairing is \"arrival\"", lambda: (
    eq(w.resolve_time_source(READ_S - 1.18, False, READ_S), "arrival", "the ordinary, correct case: arrival a measured lag before the read"),
))

check("no pairing at all is \"read\", regardless of the duplicate flag (which is meaningless without a pairing)", lambda: (
    eq(w.resolve_time_source(None, False, READ_S), "read", "nothing arrived in time"),
    eq(w.resolve_time_source(None, True, READ_S), "read", "nothing arrived in time, and duplicate is moot - still \"read\", not an error"),
))

check("FOUND ON THE BENCH 2026-09-23: pts 0 on the first frame after a restart is refused, not stored as 1970", lambda: (
    eq(w.resolve_time_source(0.0, False, READ_S), "read", "arrival 0 is the epoch, not a frame that arrived"),
    eq(w.resolve_time_source(float("nan"), False, READ_S), "read", "NaN is not a time"),
    eq(w.resolve_time_source(float("inf"), False, READ_S), "read", "infinity is not a time"),
))

check("the plausibility window's edges: up to a minute of lag, up to 2 s of clock step the other way", lambda: (
    eq(w.resolve_time_source(READ_S - w.MAX_ARRIVAL_LAG_S, False, READ_S), "arrival", "exactly a minute of lag is still believed"),
    eq(w.resolve_time_source(READ_S - w.MAX_ARRIVAL_LAG_S - 0.001, False, READ_S), "read", "past a minute of lag is refused"),
    eq(w.resolve_time_source(READ_S + w.MAX_ARRIVAL_LEAD_S, False, READ_S), "arrival", "a 2 s clock step is tolerated"),
    eq(w.resolve_time_source(READ_S + w.MAX_ARRIVAL_LEAD_S + 0.001, False, READ_S), "read", "arriving after it was read, by more than a clock step, is refused"),
))


# ---------------- stderr thread supervision (the MEDIUM fix) ----------------

class _FakeThread:
    """A stand-in for threading.Thread with just the one method main() reads."""
    def __init__(self, alive):
        self._alive = alive

    def is_alive(self):
        return self._alive


class _FakeProc:
    """A stand-in for subprocess.Popen with just the one method main() reads."""
    def __init__(self, running):
        self._running = running

    def poll(self):
        return None if self._running else 0  # real Popen.poll(): None while running


check("THE FEARED ONE: the stderr thread dying while ffmpeg keeps running is detected - the MEDIUM finding this fixes, silent forever otherwise", lambda: (
    eq(w.stderr_reader_dead(_FakeThread(alive=False), _FakeProc(running=True)), True, "thread gone, ffmpeg still going - fatal, must not be silent"),
))

check("a live stderr thread is never reported dead, regardless of ffmpeg's own state", lambda: (
    eq(w.stderr_reader_dead(_FakeThread(alive=True), _FakeProc(running=True)), False, "thread alive, ffmpeg running - normal operation"),
    eq(w.stderr_reader_dead(_FakeThread(alive=True), _FakeProc(running=False)), False, "thread has not noticed ffmpeg's exit yet - not a failure, the ordinary EOF path is about to catch it"),
))

check("the thread ending because ffmpeg itself exited is NOT the failure this detects - that is the normal 'substream ended' shutdown, not a supervision failure", lambda: (
    eq(w.stderr_reader_dead(_FakeThread(alive=False), _FakeProc(running=False)), False, "both gone together - ordinary shutdown"),
))

def stderr_reader_dead_with_a_real_thread():
    # Closer to how main() actually calls this: a REAL threading.Thread, not
    # a stand-in, run to completion (a function that returns immediately), so
    # is_alive() is exercised for real - only the ffmpeg side is faked, since
    # spawning a real ffmpeg is out of scope for this unit test (the same
    # spirit as harness/arrivalStamps.harness.mjs needing no numpy: no real
    # subprocess either).
    t = threading.Thread(target=lambda: None)
    t.start()
    t.join()
    eq(w.stderr_reader_dead(t, _FakeProc(running=True)), True, "a REAL thread that has actually finished is detected the same way as the stand-in")
    eq(w.stderr_reader_dead(t, _FakeProc(running=False)), False, "...but not once ffmpeg has also gone")
check("stderr_reader_dead works against a real threading.Thread, not just a stand-in", stderr_reader_dead_with_a_real_thread)


print(f"\narrival stamps: {total - len(failures)} passed, {len(failures)} failed")
sys.exit(1 if failures else 0)
