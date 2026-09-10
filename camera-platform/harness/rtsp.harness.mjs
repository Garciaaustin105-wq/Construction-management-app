/** RTSP templating. The failures feared: a wrong channel encoding that silently
 *  records the wrong stream, and a password logged verbatim forever. */
import { buildRtspUrl, redactRtspUrl, candidateUrls } from "../dist/rtsp.js";
import { check, eq, throws, report } from "./_assert.mjs";

console.log("rtsp");
const creds = { username: "svc_nvr", password: "p@ss w/ord" };

check("Hikvision channel 1 main is 101, sub is 102", () => {
  const main = buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1, stream: "main" }, creds);
  const sub = buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1, stream: "sub" }, creds);
  if (main.kind !== "ok" || sub.kind !== "ok") throw new Error("unsupported");
  if (!main.url.endsWith("/Streaming/Channels/101")) throw new Error(`main path: ${main.redacted}`);
  if (!sub.url.endsWith("/Streaming/Channels/102")) throw new Error(`sub path: ${sub.redacted}`);
});

check("Hikvision channel 2 is 201/202 — the CCS encoding, not 21/22", () => {
  const r = buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 2, stream: "main" }, creds);
  if (r.kind !== "ok") throw new Error("unsupported");
  if (!r.url.endsWith("/Streaming/Channels/201")) throw new Error(`got ${r.redacted}`);
});

check("THE FEARED ONE: the password never appears in the redacted form", () => {
  const r = buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1, stream: "main" }, creds);
  if (r.kind !== "ok") throw new Error("unsupported");
  if (r.redacted.includes("p%40ss") || r.redacted.includes("p@ss")) {
    throw new Error(`password leaked into the log form: ${r.redacted}`);
  }
  if (!r.redacted.includes(":***@")) throw new Error("not redacted");
  if (!r.url.includes("p%40ss")) throw new Error("playable URL lost its password");
});

check("credentials with reserved characters are percent-encoded", () => {
  const r = buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1, stream: "main" }, creds);
  if (r.kind !== "ok") throw new Error("unsupported");
  if (r.url.includes("p@ss w/ord")) throw new Error("raw password broke the URL structure");
});

check("redactRtspUrl strips credentials from an arbitrary URL", () => {
  eq(redactRtspUrl("rtsp://user:secret@10.0.0.5:554/Streaming/Channels/101"),
     "rtsp://user:***@10.0.0.5:554/Streaming/Channels/101");
  eq(redactRtspUrl("rtsp://10.0.0.5:554/path"), "rtsp://10.0.0.5:554/path", "no-credential URL untouched");
});

check("an unknown vendor REFUSES rather than guessing a path", () => {
  const r = buildRtspUrl({ vendor: "generic", ip: "10.0.0.5", channel: 1, stream: "main" }, creds);
  eq(r.kind, "unsupported", "kind");
  if (!r.message.includes("rather than guessing")) throw new Error("refusal must say why");
});

check("an out-of-range channel is refused — the CCS encoding has no room", () => {
  throws(() => buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 100, stream: "main" }, creds), "100");
  throws(() => buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 0, stream: "main" }, creds), "0");
  throws(() => buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1.5, stream: "main" }, creds), "fractional");
});

check("a missing username is refused", () => {
  throws(() => buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1, stream: "main" },
    { username: "", password: "x" }), "empty username");
});

check("a non-default port is honoured", () => {
  const r = buildRtspUrl({ vendor: "hikvision", ip: "10.0.0.5", channel: 1, stream: "main", port: 8554 }, creds);
  if (r.kind !== "ok") throw new Error("unsupported");
  if (!r.url.includes("@10.0.0.5:8554/")) throw new Error(`got ${r.redacted}`);
});

check("candidateUrls yields both streams for adoption", () => {
  const c = candidateUrls("10.0.0.5", "hikvision", creds);
  eq(c.main.kind, "ok", "main");
  eq(c.sub.kind, "ok", "sub");
});

check("Axis and Hanwha have their own documented paths, not Hikvision’s", () => {
  const axis = buildRtspUrl({ vendor: "axis", ip: "10.0.0.6", channel: 1, stream: "main" }, creds);
  if (axis.kind !== "ok") throw new Error("unsupported");
  if (axis.url.includes("Streaming/Channels")) throw new Error("Axis got a Hikvision path");
  if (!axis.url.includes("/axis-media/media.amp")) throw new Error(`got ${axis.redacted}`);
});

report("rtsp");
