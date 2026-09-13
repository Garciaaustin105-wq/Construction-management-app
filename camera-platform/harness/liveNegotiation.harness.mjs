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
  activeForCamera: 0,
  activeTotal: 0,
  maxPerCamera: 2,
  maxTotal: 16,
  streamId: "s-123",
};
const live = (over) => negotiateLive({ ...base, ...over });
const refused = (r, reason, what) =>
  same([r.kind, r.reason], ["refused", reason], what);

check("happy path: ok with mode ws-fmp4, cameraId and streamId echoed verbatim", () => {
  const r = live({});
  same(r, { kind: "ok", cameraId: "cam-1", quality: "mainstream", mode: "ws-fmp4", streamId: "s-123" },
    "full shape");
});

check("THE FEARED ONE: unknown camera wins over everything — even all caps saturated and url unresolved", () => {
  const r = live({
    cameraExists: false, resolution: UNRESOLVED,
    quality: "substream", substreamUrl: null,
    activeForCamera: 99, activeTotal: 99,
  });
  refused(r, "unknown_camera", "unknown beats busy and unresolved");
  same(r.detail.includes("cam-1") === false, true, "detail is static, not an echo");
});

check("unresolved refused before substream/busy/limit", () => {
  const r = live({
    resolution: UNRESOLVED, quality: "substream",
    activeForCamera: 99, activeTotal: 99,
  });
  refused(r, "unresolved_camera", "unresolved beats caps");
});

check("substream_unavailable: no manual url AND vendor cannot derive", () => {
  refused(live({ quality: "substream", substreamUrl: null, vendorDerivesSubstream: false }),
    "substream_unavailable", "neither source");
  // before the caps: saturated caps + unavailable substream is still substream_unavailable
  refused(live({ quality: "substream", activeForCamera: 2, activeTotal: 16 }),
    "substream_unavailable", "beats camera_busy");
  refused(live({ quality: "substream", activeTotal: 16, activeForCamera: 0 }),
    "substream_unavailable", "beats stream_limit");
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

check("camera_busy at the per-camera cap, appliance cap far from held", () => {
  refused(live({ activeForCamera: 2, maxPerCamera: 2, activeTotal: 3 }), "camera_busy", "at cap");
  same(live({ activeForCamera: 1, maxPerCamera: 2 }).kind, "ok", "one under the cap is ok");
});

check("stream_limit at the appliance cap with per-camera under its cap", () => {
  refused(live({ activeTotal: 16, maxTotal: 16, activeForCamera: 1 }), "stream_limit", "at cap");
  same(live({ activeTotal: 15, maxTotal: 16 }).kind, "ok", "one under the cap is ok");
});

check("refusal details never echo a credential-bearing url", () => {
  const url = "rtsp://admin:s3cret-pw$.*@10.9.9.9:9999/ch1";
  const r = live({ cameraId: url, cameraExists: false }); // hostile id; detail is static either way
  same(r.detail.includes("s3cret-pw") || r.detail.includes("10.9.9.9"), false, "no url fragments");
  const u = live({ resolution: UNRESOLVED, substreamUrl: url });
  same([u.detail.includes("s3cret-pw"), u.detail.includes("10.9.9.9")], [false, false],
    "unresolved detail too");
});

check("liveFfmpegArgs: copy only, ends pipe:1, url appears once after -i", () => {
  const args = liveFfmpegArgs("rtsp://u:p@10.0.0.5:554/ch1");
  same(args[args.length - 1], "pipe:1", "stdout is the pipe");
  same(args.includes("-c") && args[args.indexOf("-c") + 1], "copy", "-c copy");
  same(args.includes("-vf") || args.includes("-c:v") || args.includes("-c:a"), false,
    "no transcode flags");
  same(args.indexOf("rtsp://u:p@10.0.0.5:554/ch1") >= 0, true, "url present");
  same(args.indexOf("rtsp://u:p@10.0.0.5:554/ch1"), args.indexOf("-i") + 1, "url right after -i");
  same(args.length, 15, "exact shape");
  same(args.includes("frag_keyframe+empty_moov"), true, "fragmented mp4");
  same(args.includes("+nobuffer") && args.includes("low_delay"), true, "latency flags");
});

report("liveNegotiation");