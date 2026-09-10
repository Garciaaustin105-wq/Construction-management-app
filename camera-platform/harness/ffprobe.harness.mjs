/** ffprobe interpretation. The failure feared: accepting a camera's configured
 *  bitrate as measured, or inventing one when RTSP reports none. */
import { parseFfprobeJson, parseFrameRate, bitrateFromCapture } from "../dist/ffprobe.js";
import { check, eq, report } from "./_assert.mjs";

console.log("ffprobe");

// Shaped like real `ffprobe -print_format json -show_streams -show_format` output.
const hikH265 = {
  streams: [
    { index: 0, codec_name: "hevc", codec_type: "video", width: 2688, height: 1520,
      avg_frame_rate: "20/1", r_frame_rate: "20/1" },
    { index: 1, codec_name: "pcm_alaw", codec_type: "audio", sample_rate: "8000" },
  ],
  format: { format_name: "rtsp", duration: "N/A", bit_rate: "N/A" },
};

check("THE FEARED ONE: RTSP reporting no bitrate yields null, not a guess", () => {
  const r = parseFfprobeJson(hikH265);
  eq(r.kind, "ok", "kind");
  eq(r.stream.bitrateKbps, null, "null forces the agent to measure it");
});

check("codec, resolution and fps come through", () => {
  const r = parseFfprobeJson(hikH265);
  eq(r.stream.codec, "h265", "hevc maps to h265");
  eq(r.stream.width, 2688, "width");
  eq(r.stream.height, 1520, "height");
  eq(r.stream.fps, 20, "fps");
});

check("audio presence is reported even though we do not record it", () => {
  eq(parseFfprobeJson(hikH265).stream.hasAudio, true, "audio flagged for the legal gate");
  const silent = { ...hikH265, streams: [hikH265.streams[0]] };
  eq(parseFfprobeJson(silent).stream.hasAudio, false, "no audio");
});

check("a reported bitrate is converted to kbps", () => {
  const withRate = { streams: [{ ...hikH265.streams[0], bit_rate: "4096000" }], format: {} };
  eq(parseFfprobeJson(withRate).stream.bitrateKbps, 4096, "kbps");
});

check("format-level bitrate is used when the stream lacks one", () => {
  const r = parseFfprobeJson({ streams: [hikH265.streams[0]], format: { bit_rate: "2048000" } });
  eq(r.stream.bitrateKbps, 2048, "kbps from format");
});

check("an unsupported codec is refused — it cannot be stream-copied", () => {
  const mjpeg = { streams: [{ codec_name: "mjpeg", codec_type: "video", width: 640, height: 480 }], format: {} };
  const r = parseFfprobeJson(mjpeg);
  eq(r.kind, "unusable", "kind");
  if (!r.reason.includes("stream-copied")) throw new Error("reason must explain why");
});

check("a URL that did not open is refused, not treated as an empty camera", () => {
  eq(parseFfprobeJson({ streams: [] }).kind, "unusable", "no streams");
  eq(parseFfprobeJson({}).kind, "unusable", "no streams key");
  eq(parseFfprobeJson(null).kind, "unusable", "null");
  eq(parseFfprobeJson("not json").kind, "unusable", "string");
});

check("an audio-only URL is refused", () => {
  const r = parseFfprobeJson({ streams: [{ codec_name: "pcm_alaw", codec_type: "audio" }], format: {} });
  eq(r.kind, "unusable", "kind");
});

check("frame rates parse, including the unknown 0/0", () => {
  eq(parseFrameRate("20/1"), 20, "20/1");
  eq(parseFrameRate("30000/1001"), 30000 / 1001, "ntsc");
  eq(parseFrameRate("0/0"), null, "unknown");
  eq(parseFrameRate("N/A"), null, "N/A");
  eq(parseFrameRate(undefined), null, "missing");
});

check("THE FEARED ONE: a too-short capture is refused as a bitrate measurement", () => {
  const r = bitrateFromCapture(5_000_000, 2);
  eq(r.kind, "refused", "2 seconds is not a measurement");
  if (!r.reason.includes("variable-bitrate")) throw new Error("reason must explain why");
});

check("a proper capture yields kbps", () => {
  // 30 s at 2000 kbps is 7,500,000 bytes.
  const r = bitrateFromCapture(7_500_000, 30);
  eq(r.kind, "ok", "kind");
  eq(r.bitrateKbps, 2000, "kbps");
});

check("a capture that wrote nothing is refused", () => {
  eq(bitrateFromCapture(0, 30).kind, "refused", "no bytes");
});

report("ffprobe");
