/** Live negotiation. The failure feared here is order: a refusal that answers
 *  the wrong question. An unknown camera told "busy" confirms the camera exists
 *  and is watched; a saturated appliance answering "no substream" hides the
 *  real reason. The decision order in the contract is load-bearing and every
 *  check below pins a boundary of it — first hit wins, never the first
 *  plausible-sounding hit. The other fear is the argv drifting toward a
 *  transcode: the appliance's CPU is not a transcode farm, so `-c copy` only. */
import {
  negotiateLive, liveFfmpegArgs,
} from "../dist/liveNegotiation.js";
import { check, same, report } from "./_assert.mjs";

console.log("liveNegotiation");

const OK = { kind: "ok", origin: "manual_url", url: "rtsp://u:p@10.0.0.5:554/ch1" };
const UNRESOLVED = { kind: "unresolved", reason: "no template for this vendor" };
const base = {
  cameraId: "cam-1",
  cameraExists: true,
  quality: "mainstream",
  resolution: OK,
  substreamUrl: null,
  vendorDerivesSubstream: false,
  sourceRunning: false,
  sourcesForCamera: 0,
  sourcesTotal: 0,
  viewersTotal: 0,
  maxSourcesPerCamera: 2,
  maxSources: 32,
  maxViewers: 128,
  streamId: "s-123",
};
const live = (over) => negotiateLive({ ...base, ...over });
const refused = (r, reason, what) =>
  same([r.kind, r.reason], ["refused", reason], what);

check("happy path: ok with mode ws-fmp4, cameraId and streamId echoed verbatim", () => {
  const r = live({});
  same(r, { kind: "ok", cameraId: "cam-1", quality: "mainstream", mode: "ws-fmp4", streamId: "s-123", shared: false },
    "full shape");
});

check("THE FEARED ONE: unknown camera wins over everything — even all caps saturated and url unresolved", () => {
  const r = live({
    cameraExists: false, resolution: UNRESOLVED,
    quality: "substream", substreamUrl: null,
    sourcesForCamera: 99, sourcesTotal: 99, viewersTotal: 999,
  });
  refused(r, "unknown_camera", "unknown beats busy and unresolved");
  same(r.detail.includes("cam-1") === false, true, "detail is static, not an echo");
});

check("unresolved refused before substream/busy/limit", () => {
  const r = live({
    resolution: UNRESOLVED, quality: "substream",
    sourcesForCamera: 99, sourcesTotal: 99, viewersTotal: 999,
  });
  refused(r, "unresolved_camera", "unresolved beats caps");
});

check("substream_unavailable: no manual url AND vendor cannot derive", () => {
  refused(live({ quality: "substream", substreamUrl: null, vendorDerivesSubstream: false }),
    "substream_unavailable", "neither source");
  // before the caps: saturated caps + unavailable substream is still substream_unavailable
  refused(live({ quality: "substream", sourcesForCamera: 2, sourcesTotal: 32 }),
    "substream_unavailable", "beats camera_busy");
  refused(live({ quality: "substream", sourcesTotal: 32, sourcesForCamera: 0 }),
    "substream_unavailable", "beats stream_limit");
  refused(live({ quality: "substream", viewersTotal: 128 }),
    "substream_unavailable", "beats viewer_limit");
  // mainstream with identical inputs is fine — the refusal is about the substream only
  same(live({ quality: "substream", vendorDerivesSubstream: true }).kind, "ok", "vendor derives");
  same(live({ quality: "substream", substreamUrl: "rtsp://u:p@10.0.0.5:554/ch0" }).kind, "ok",
    "manual url");
});

check("manual substreamUrl wins verbatim even when the vendor cannot derive", () => {
  const manual = "rtsp://admin:pw!$*.@10.0.0.5:554/Streaming/Channels/102";
  const r = live({ quality: "substream", substreamUrl: manual, vendorDerivesSubstream: false });
  same(r.kind, "ok", "manual beats no-derivation");
  // and the negotiated quality is what was asked for, not upgraded
  same(r.quality, "substream", "quality kept");
});

check("THE FEARED ONE: joining a running source opens no camera session, so the source caps never refuse it", () => {
  // A 3-TV x 9-tile site: 27 tiles of 16 cameras. Every source cap is held,
  // and a viewer of a camera already streaming must still get in.
  const r = live({ sourceRunning: true, sourcesForCamera: 2, sourcesTotal: 32, viewersTotal: 27 });
  same(r.kind, "ok", "joins");
  same(r.shared, true, "and says it shares the running source");
});

check("camera_busy counts SOURCES on this camera, only when a new source is needed", () => {
  refused(live({ sourcesForCamera: 2, maxSourcesPerCamera: 2, sourcesTotal: 3 }), "camera_busy", "at cap");
  same(live({ sourcesForCamera: 1, maxSourcesPerCamera: 2 }).kind, "ok", "one under the cap is ok");
});

check("stream_limit counts SOURCES appliance-wide, not viewers", () => {
  refused(live({ sourcesTotal: 32, maxSources: 32, sourcesForCamera: 1 }), "stream_limit", "at cap");
  same(live({ sourcesTotal: 31, maxSources: 32, viewersTotal: 100 }).kind, "ok", "one under the cap is ok, whatever the viewers");
});

check("THE FEARED ONE: viewer_limit protects the box, and applies to a shared join too", () => {
  refused(live({ viewersTotal: 128, maxViewers: 128 }), "viewer_limit", "new source");
  refused(live({ viewersTotal: 128, maxViewers: 128, sourceRunning: true }), "viewer_limit", "shared join");
  same(live({ viewersTotal: 127, maxViewers: 128, sourceRunning: true }).kind, "ok", "one under is ok");
  // Order: a new source at every cap names the camera first (the per-camera
  // answer is the most specific), then the appliance, then viewers.
  refused(live({ sourcesForCamera: 2, sourcesTotal: 32, viewersTotal: 128 }), "camera_busy", "busy first");
  refused(live({ sourcesForCamera: 0, sourcesTotal: 32, viewersTotal: 128 }), "stream_limit", "then stream_limit");
});

check("refusal details never echo a credential-bearing url", () => {
  const url = "rtsp://admin:s3cret-pw$.*@10.9.9.9:9999/ch1";
  const r = live({ cameraId: url, cameraExists: false }); // hostile id; detail is static either way
  same(r.detail.includes("s3cret-pw") || r.detail.includes("10.9.9.9"), false, "no url fragments");
  const u = live({ resolution: UNRESOLVED, substreamUrl: url });
  same([u.detail.includes("s3cret-pw"), u.detail.includes("10.9.9.9")], [false, false],
    "unresolved detail too");
});

check("liveFfmpegArgs: video copied, audio re-encoded, ends pipe:1, url once after -i", () => {
  const args = liveFfmpegArgs("rtsp://u:p@10.0.0.5:554/ch1");
  same(args[args.length - 1], "pipe:1", "stdout is the pipe");
  same(args.includes("-c:v") && args[args.indexOf("-c:v") + 1], "copy", "-c:v copy");
  // The appliance is not a transcoding farm: no video filter, no video encoder.
  same(args.includes("-vf"), false, "video never filtered");
  same(args.includes("-c"), false, "no blanket -c that would recopy audio too");
  // Audio IS re-encoded, on purpose: mp4 cannot hold G.711, and a failed mux
  // takes the picture down with it.
  same(args.includes("-c:a") && args[args.indexOf("-c:a") + 1], "aac", "audio to aac");
  same(args.includes("-b:a") && args[args.indexOf("-b:a") + 1], "32k", "voice-grade audio rate");
  same(args.includes("0:a:0?"), true, "optional audio map: mic-less cameras still work");
  same(args.includes("0:v:0"), true, "explicit video map");
  same(args.indexOf("rtsp://u:p@10.0.0.5:554/ch1") >= 0, true, "url present");
  same(args.indexOf("rtsp://u:p@10.0.0.5:554/ch1"), args.indexOf("-i") + 1, "url right after -i");
  same(args.length, 27, "exact shape");
  same(args.includes("frag_keyframe+empty_moov+default_base_moof"), true, "fragmented mp4, MSE-safe addressing");
  // `default_base_moof` is load-bearing: MSE forbids tfhd's absolute
  // base_data_offset ("TFHD base-data-offset not allowed by MSE"), and a
  // missing one makes the FIRST fragment append fail with a decode error that
  // every later append then rides as InvalidStateError.
  same(args.includes("+nobuffer") && args.includes("low_delay"), true, "latency flags");
  // The probe cap is load-bearing for live start latency: ffmpeg's default
  // samples up to 5 s of input; the copy mux needs only the parameter sets.
  same(args.includes("-probesize") && args.includes("500000"), true, "probesize capped");
  same(args.includes("-analyzeduration") && args.includes("500000"), true, "analyzeduration capped");
});

report("liveNegotiation");