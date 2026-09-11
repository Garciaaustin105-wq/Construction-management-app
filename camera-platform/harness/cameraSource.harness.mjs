/** Manual camera entry. The failure feared — and watched happen in a
 *  competitor's product: discovery is the ONLY way in, so when it fails the
 *  installer is stuck at a site with a working camera and no way to add it. */
import { parseRtspUrl, manualSource, overrideSource, wasManual } from "../dist/cameraSource.js";
import { check, eq, throws, report } from "./_assert.mjs";

console.log("camera source");

check("THE FEARED ONE: a pasted URL always works, whatever discovery did", () => {
  const r = parseRtspUrl("rtsp://admin:hunter2@192.168.1.64:554/Streaming/Channels/101");
  eq(r.kind, "ok", "accepted");
  eq(r.host, "192.168.1.64", "host");
  eq(r.port, 554, "port");
  eq(r.path, "/Streaming/Channels/101", "path");
  eq(r.username, "admin", "user");
});

check("a non-standard port is honoured, not corrected", () => {
  eq(parseRtspUrl("rtsp://10.0.0.5:8554/live").port, 8554, "8554");
});

check("no port means 554", () => {
  eq(parseRtspUrl("rtsp://10.0.0.5/live").port, 554, "default");
});

check("no credentials in the URL is fine — many cameras take them separately", () => {
  const r = parseRtspUrl("rtsp://10.0.0.5/profile1");
  eq(r.kind, "ok", "accepted");
  eq(r.username, null, "no user");
  eq(r.password, null, "no password");
});

check("a query string survives — some vendors put the channel there", () => {
  const r = parseRtspUrl("rtsp://10.0.0.5/cam/realmonitor?channel=1&subtype=0");
  eq(r.path, "/cam/realmonitor?channel=1&subtype=0", "query kept");
});

check("a bare host with no path is accepted, not second-guessed", () => {
  const r = parseRtspUrl("rtsp://10.0.0.5");
  eq(r.kind, "ok", "accepted — let the probe decide");
  eq(r.path, "/", "defaulted");
});

check("percent-encoded credentials decode", () => {
  const r = parseRtspUrl("rtsp://admin:p%40ss@10.0.0.5/live");
  eq(r.password, "p@ss", "decoded");
});

check("a stray percent does not reject the installer's URL", () => {
  const r = parseRtspUrl("rtsp://admin:100%pass@10.0.0.5/live");
  eq(r.kind, "ok", "still accepted");
});

check("genuinely unusable input is refused with a reason", () => {
  eq(parseRtspUrl("").kind, "invalid", "empty");
  eq(parseRtspUrl("http://10.0.0.5/live").kind, "invalid", "wrong scheme");
  eq(parseRtspUrl("rtsp://10.0.0.5:99999/live").kind, "invalid", "port out of range");
  if (!parseRtspUrl("http://x/y").reason.includes("rtsp")) throw new Error("reason must say what is wrong");
});

check("THE FEARED ONE: a raw '@' in the password splits at the last '@', as ffmpeg does", () => {
  const r = parseRtspUrl("rtsp://a:b@c@10.0.0.5/x");
  eq([r.kind, r.host, r.port, r.path, r.username, r.password], ["ok", "10.0.0.5", 554, "/x", "a", "b@c"], "parts");
  eq(parseRtspUrl("rtsp://admin:p@ss@10.0.0.7:8554/live").host, "10.0.0.7", "host is the host");
});

check("THE FEARED ONE: a password that breaks the URL is refused, and the reason never quotes it", () => {
  const cases = {
    "rtsp://admin:hun/ter2@10.0.0.5/x": ["hun", "ter2"],
    "rtsp://admin:x?y9z@10.0.0.5/x": ["x?y", "y9z"],
    "rtsp://admin:hunter2": ["hunter2"],
    "rtsp://admin:12345678": ["12345678", "1234"],
    "rtsp://admin:hunter2@": ["hunter2"],
  };
  for (const [url, fragments] of Object.entries(cases)) {
    const r = parseRtspUrl(url);
    eq(r.kind, "invalid", url);
    for (const f of fragments) {
      if (r.reason.includes(f)) throw new Error(`${url}: reason quotes ${JSON.stringify(f)}: ${r.reason}`);
    }
  }
  if (!parseRtspUrl("rtsp://admin:hun/ter2@10.0.0.5/x").reason.includes("%2F")) {
    throw new Error("a raw '/' in a password should be told how to encode it");
  }
});

check("credentials with no username are refused, not half-used", () => {
  eq(parseRtspUrl("rtsp://:pw@10.0.0.5/x").kind, "invalid", "password only");
  eq(parseRtspUrl("rtsp://@10.0.0.5/x").kind, "invalid", "empty userinfo");
  eq(parseRtspUrl("rtsp://admin@10.0.0.5/x").password, null, "a username alone is fine");
});

check("an '@' in the path is the vendor's, not credentials", () => {
  const r = parseRtspUrl("rtsp://10.0.0.6:554/user=admin&password=p@ss&channel=1");
  eq([r.kind, r.host, r.port, r.username], ["ok", "10.0.0.6", 554, null], "authority ends at the first '/'");
});

check("an empty port is the default, per RFC 3986; a fragment is dropped", () => {
  const r = parseRtspUrl("rtsp://10.0.0.5:/live#t=5");
  eq([r.kind, r.port, r.path], ["ok", 554, "/live"], "parts");
  eq(parseRtspUrl("rtsp://10.0.0.5/a?b=1#frag").path, "/a?b=1", "query kept, fragment dropped");
  eq(parseRtspUrl("rtsp://10.0.0.5?b=1").path, "/?b=1", "query with no path");
});

check("a manual camera is not marked as a lesser kind of camera", () => {
  const parsed = parseRtspUrl("rtsp://10.0.0.5:8554/odd/path");
  const source = manualSource("cam-7", parsed);
  eq(source.origin, "manual_url", "origin recorded");
  eq(source.path, "/odd/path", "path used verbatim");
  eq(wasManual(source), true, "flagged for the console, not penalised");
});

check("overriding a discovered camera keeps what the template got wrong", () => {
  const discovered = {
    cameraId: "cam-3", origin: "discovered", host: "10.0.0.9", port: 554,
    path: "/profile1", vendor: "avycon", stream: "main",
  };
  const fixed = overrideSource(discovered, "/profile2");
  eq(fixed.path, "/profile2", "corrected");
  eq(fixed.overrodeTemplatePath, "/profile1", "original kept");
  eq(fixed.origin, "overridden", "origin updated");
  eq(wasManual(fixed), true, "counts as human intervention");
});

check("an empty override is refused — that is a mistake, not a choice", () => {
  throws(() => overrideSource({ cameraId: "c", origin: "discovered", host: "h", port: 554, path: "/p", vendor: "generic", stream: "main" }, "  "));
});

report("camera source");
