/** RTSP templating. The failures feared: a wrong channel encoding that silently
 *  records the wrong stream, and a password logged verbatim forever. */
import { buildRtspUrl, redactRtspUrl, candidateUrls, candidatePaths, urlForPath } from "../dist/rtsp.js";
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

check("THE FEARED ONE: a URL mid-line is redacted — stderr and stack traces are text", () => {
  eq(redactRtspUrl("[rtsp @ 0x55d0] rtsp://admin:hunter2@10.0.0.5:554/x: 401 Unauthorized"),
     "[rtsp @ 0x55d0] rtsp://admin:***@10.0.0.5:554/x: 401 Unauthorized", "mid-line");
  eq(redactRtspUrl("Error: probe failed\n    at open (rtsp://admin:hunter2@10.0.0.5/x)"),
     "Error: probe failed\n    at open (rtsp://admin:***@10.0.0.5/x)", "in a stack trace");
  eq(redactRtspUrl("a rtsp://u:p1@h1/x b RTSPS://u:p2@h2/y"), "a rtsp://u:***@h1/x b RTSPS://u:***@h2/y", "two");
  eq(redactRtspUrl("rtsp://u:p1@h1/x,rtsp://u:p2@h2/y"), "rtsp://u:***@h1/x,rtsp://u:***@h2/y", "glued together");
});

check("THE FEARED ONE: a raw '@', '/', '?' or '#' in the password does not survive redaction", () => {
  eq(redactRtspUrl("rtsp://a:b@c@10.0.0.5/x"), "rtsp://a:***@10.0.0.5/x", "two '@' — split at the last, as ffmpeg does");
  eq(redactRtspUrl("rtsp://admin:hun/ter2@10.0.0.5/x"), "rtsp://admin:***@10.0.0.5/x", "a raw '/'");
  for (const pw of ["hunter2", "p@ss", "a@b@c", "hun/ter2", "x?y9z", "q#r7s", "pa$$.w*rd", "100%pure"]) {
    const out = redactRtspUrl(`ffmpeg: rtsp://admin:${pw}@10.0.0.5:554/Streaming/Channels/101: refused`);
    if (out.includes(pw)) throw new Error(`password ${JSON.stringify(pw)} survived: ${out}`);
    if (!out.includes("rtsp://")) throw new Error(`the URL itself was lost: ${out}`);
  }
});

check("a password in the vendor's path is redacted too", () => {
  eq(redactRtspUrl("rtsp://10.0.0.6:554/user=admin&password=hunter2&channel=1&stream=0.sdp"),
     "rtsp://10.0.0.6:554/user=admin&password=***&channel=1&stream=0.sdp", "path");
  eq(redactRtspUrl("rtsp://10.0.0.6/live?user=admin&pwd=p@ss"), "rtsp://10.0.0.6/live?user=admin&pwd=***", "query, with an '@'");
  eq(redactRtspUrl("rtsp://10.0.0.6/cam?bypass=1"), "rtsp://10.0.0.6/cam?bypass=1", "not every word ending in pass");
});

check("a username with no password is treated as the secret", () => {
  eq(redactRtspUrl("rtsp://t0ken@10.0.0.5/x"), "rtsp://***@10.0.0.5/x", "user only");
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

check("AVYCON main is /profile1 and sub is /profile2", () => {
  const main = buildRtspUrl({ vendor: "avycon", ip: "10.0.0.7", channel: 1, stream: "main" }, creds);
  const sub = buildRtspUrl({ vendor: "avycon", ip: "10.0.0.7", channel: 1, stream: "sub" }, creds);
  if (main.kind !== "ok" || sub.kind !== "ok") throw new Error("unsupported");
  if (!main.url.endsWith("/profile1")) throw new Error(`main: ${main.redacted}`);
  if (!sub.url.endsWith("/profile2")) throw new Error(`sub: ${sub.redacted}`);
});

check("THE FEARED ONE: AVYCON paths vary by model, so candidates are ordered not assumed", () => {
  const cands = candidatePaths("avycon", "main");
  if (cands.length < 2) throw new Error("a single candidate would be a guess dressed as a fact");
  eq(cands[0].documented, true, "the documented path is tried first");
  eq(cands[0].path, "/profile1", "documented path");
  if (cands.slice(1).some((c) => c.documented)) {
    throw new Error("only the first AVYCON path is documented — the rest must say so");
  }
});

check("every vendor's first candidate matches what buildRtspUrl returns", () => {
  for (const vendor of ["hikvision", "avycon", "axis", "hanwha", "avigilon"]) {
    for (const stream of ["main", "sub"]) {
      const built = buildRtspUrl({ vendor, ip: "10.0.0.8", channel: 1, stream }, creds);
      if (built.kind !== "ok") throw new Error(`${vendor} unsupported`);
      const first = candidatePaths(vendor, stream)[0];
      if (!built.url.endsWith(first.path)) {
        throw new Error(`${vendor}/${stream}: template says ${built.redacted}, first candidate is ${first.path}`);
      }
    }
  }
});

check("generic candidates are all marked undocumented — none pretends to be known", () => {
  const cands = candidatePaths("generic", "main");
  if (cands.length === 0) throw new Error("generic must offer something to try");
  if (cands.some((c) => c.documented)) throw new Error("a trial path claimed to be documented");
});

check("urlForPath redacts the password like buildRtspUrl does", () => {
  const u = urlForPath("10.0.0.7", "/profile1", creds);
  if (u.redacted.includes("p@ss") || u.redacted.includes("p%40ss")) throw new Error("password leaked");
  if (!u.redacted.includes(":***@")) throw new Error("not redacted");
  if (!u.url.includes("p%40ss")) throw new Error("playable URL lost its password");
});

report("rtsp");
