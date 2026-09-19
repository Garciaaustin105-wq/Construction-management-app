/** Reconnecting a live tile (agent/ui/live-client.mjs reconnectDelayMs).
 *  THE FEARED FAILURES: a tight retry loop that floods the recorder, and
 *  retrying forever something that can never work. */
import {
  reconnectDelayMs, RECONNECT_FIRST_MS, RECONNECT_MAX_MS, RECONNECT_REASONS, mainstreamFallback, liveTileText,
} from "../agent/ui/live-client.mjs";
import { check, eq, report } from "./_assert.mjs";

console.log("liveReconnect");

check("constants", () => {
  eq([RECONNECT_FIRST_MS, RECONNECT_MAX_MS], [2000, 30000], "2 s first, 30 s at most");
  eq([...RECONNECT_REASONS], ["closed", "stalled", "ended", "source_failed", "mainstream_failed"], "reasons");
  eq(Object.isFrozen(RECONNECT_REASONS), true, "frozen");
});

check("backs off, and never faster than 2 s", () => {
  eq([0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelayMs("closed", a)),
    [2000, 4000, 8000, 16000, 30000, 30000, 30000], "doubling to the cap");
  for (const r of RECONNECT_REASONS) eq(reconnectDelayMs(r, 0), 2000, r);
});

check("THE FEARED ONE: a long outage never turns into a tight loop or a broken timer", () => {
  for (const a of [40, 1024, 1e6, Number.MAX_SAFE_INTEGER]) {
    eq(reconnectDelayMs("closed", a), 30000, `attempt ${a}`);
  }
  for (const a of [-1, 1.5, NaN, Infinity, "3", null, undefined]) {
    eq(reconnectDelayMs("stalled", a), 30000, `bad attempt ${String(a)}`);
  }
});

check("THE FEARED ONE: what can never work is not retried", () => {
  for (const r of ["codec_unsupported", "codec_unreadable", "", "CLOSED", null, undefined, 3, {}]) {
    eq(reconnectDelayMs(r, 0), null, `reason ${String(r)}`);
  }
});

// A phone's browser can say it plays H.264 and then refuse a 2560x1440 main
// stream when it decodes it (bench, 2026-09-19: "video element error 4" on a
// phone, the same stream fine on a PC, the substream fine on both). The
// upfront isTypeSupported fallback never saw it: the tile just showed the error.
check("THE FEARED ONE: a main stream the browser fails to play falls back to the substream, and says why", () => {
  const codecMime = 'video/mp4; codecs="avc1.4D0033"';
  for (const [kind, code] of [["video", 3], ["video", 4], ["append", 0]]) {
    const why = mainstreamFallback({ quality: "mainstream", mainUnplayable: null, kind, errorCode: code, codecMime });
    if (typeof why !== "string" || !why.includes("avc1.4D0033")) throw new Error(`${kind} ${code}: expected a reason naming the codec, got ${JSON.stringify(why)}`);
  }
  eq(mainstreamFallback({ quality: "mainstream", mainUnplayable: null, kind: "video", errorCode: 4, codecMime }),
    "avc1.4D0033 (video error 4)", "the reason the tile shows");
});

check("THE FEARED ONE: never a fallback that could ping-pong or hide a real fault", () => {
  const codecMime = 'video/mp4; codecs="avc1.4D0033"';
  eq(mainstreamFallback({ quality: "substream", mainUnplayable: null, kind: "video", errorCode: 4, codecMime }), null, "the substream has nowhere to fall to");
  eq(mainstreamFallback({ quality: "mainstream", mainUnplayable: "hvc1 (x)", kind: "video", errorCode: 4, codecMime }), null, "already fell back once");
  eq(mainstreamFallback({ quality: "mainstream", mainUnplayable: null, kind: "video", errorCode: 1, codecMime }), null, "aborted is not a codec problem");
  eq(mainstreamFallback({ quality: "mainstream", mainUnplayable: null, kind: "video", errorCode: 2, codecMime }), null, "network is the reconnect's job");
  // Bench 2026-09-19: switching a PC tile to High reset the <video> with
  // src = '', Chrome reported that as error 4 before the new stream had even
  // started, and the tile fell back for good ("full quality is full quality
  // (video error 4)"). No codec yet means no stream of ours was playing.
  eq(mainstreamFallback({ quality: "mainstream", mainUnplayable: null, kind: "video", errorCode: 4, codecMime: null }),
    null, "THE FEARED ONE: an error before any stream started is not this stream failing");
});

check("THE FEARED ONE: a tile's words are plain and fixed, never a code, never anything the server or ffmpeg said", () => {
  const plain = {
    closed: "Connection lost — reconnecting",
    source_failed: "Camera offline — reconnecting",
    live_source_failed: "Camera offline — reconnecting",
    stalled: "Camera stopped sending video — reconnecting",
    live_stalled: "Camera stopped sending video — reconnecting",
    ended: "Camera stopped sending video — reconnecting",
    live_ended: "Camera stopped sending video — reconnecting",
    mainstream_failed: "Camera not available — reconnecting",
    camera_busy: "Too many live streams — try fewer cameras",
    stream_limit: "Too many live streams — try fewer cameras",
    viewer_limit: "Too many people watching — try again later",
    unknown_camera: "This camera is not set up on this recorder",
    unresolved_camera: "This camera's address is not set up",
    substream_unavailable: "This camera has no low-quality stream",
    unsupported: "This browser can't show this camera's video",
    connecting: "Connecting…",
  };
  for (const [code, words] of Object.entries(plain)) eq(liveTileText(code), words, code);
  for (const junk of ["rtsp://admin:pw@10.0.0.1/x", "weird_new_code", "", undefined, 42]) {
    eq(liveTileText(junk), "Camera not available", `unknown input -> generic, never echoed (${String(junk)})`);
  }
});

report("live reconnect");
