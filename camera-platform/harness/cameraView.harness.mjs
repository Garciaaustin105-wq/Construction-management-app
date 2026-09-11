/** The camera list. The failure feared is a password in a response body: in the
 *  url's userinfo, in a vendor path, behind a raw '@', percent-encoded, or
 *  echoed back inside an error reason. Every check serialises the whole view
 *  and searches it, because a leak in a field nobody thought to test is still
 *  a leak. */
import { cameraView } from "../dist/cameraView.js";
import { check, same, report } from "./_assert.mjs";

console.log("cameraView");

const OK = { kind: "ok", origin: "manual_url", url: "rtsp://unused" };
const KEYS = ["bitrateKbps", "cameraId", "channel", "host", "name", "origin", "port", "resolved",
  "unresolvedReason", "vendor"];

function clean(view, secrets, what) {
  same(Object.keys(view).sort(), KEYS, `${what}: exactly the named fields, nothing else`);
  const text = JSON.stringify(view);
  for (const s of secrets) {
    if (text.includes(s)) throw new Error(`${what}: the view contains ${JSON.stringify(s)}: ${text}`);
  }
}

check("a url with credentials gives its host and port, and nothing else of itself", () => {
  const url = "rtsp://admin:hunter2@10.0.0.5:8554/Streaming/Channels/101";
  const v = cameraView({ cameraId: "cam-1", name: "Front door", url, vendor: "hikvision", channel: 1,
    bitrateKbps: 4000 }, OK);
  same(v, {
    cameraId: "cam-1", name: "Front door", vendor: "hikvision", host: "10.0.0.5", port: 8554, channel: 1,
    origin: "manual_url", resolved: true, unresolvedReason: null, bitrateKbps: 4000,
  }, "view");
  clean(v, ["hunter2", "admin", "Streaming", "rtsp:", url], "userinfo");
});

check("a url with no port is port 554, as parseRtspUrl says", () => {
  same(cameraView({ cameraId: "cam-1", url: "rtsp://10.0.0.5/live" }, OK).port, 554, "default");
});

check("THE FEARED ONE: a password in the vendor's path never reaches the view", () => {
  const url = "rtsp://10.0.0.6/user=admin&password=hunter2&channel=1&stream=0.sdp";
  const v = cameraView({ cameraId: "cam-2", url }, OK);
  same([v.host, v.port], ["10.0.0.6", 554], "host and port");
  clean(v, ["hunter2", "password", "user=", "sdp"], "path password");
});

check("THE FEARED ONE: a raw '@' in the password does not become part of the host", () => {
  // ffmpeg splits userinfo at the LAST '@' of the authority; so must we.
  for (const [url, secrets] of [
    ["rtsp://admin:p@ss@10.0.0.7/x", ["p@ss", "ss@", "@"]],
    ["rtsp://admin:a@b@c@10.0.0.7:554/x", ["a@b@c", "b@c", "@"]],
  ]) {
    const v = cameraView({ cameraId: "cam-3", url }, OK);
    same([v.host, v.port], ["10.0.0.7", 554], url);
    clean(v, secrets, url);
  }
});

check("THE FEARED ONE: a reason echoing the url, the password or its encoding is scrubbed", () => {
  const url = "rtsp://admin:hun%40ter2@10.0.0.8/x";
  const view = (reason) => cameraView({ cameraId: "cam-4", url }, { kind: "unresolved", reason });
  const secrets = ["hun@ter2", "hun%40ter2", "admin", url];
  const cases = [
    [`probe failed for ${url}`, "probe failed for ***"],
    ["401 for hun@ter2", "401 for ***"],
    ["401 for hun%40ter2", "401 for ***"],
    ["tried hun@ter2, then hun@ter2 again", "tried ***, then *** again"],
    [`${url} and ${url}`, "*** and ***"],
  ];
  for (const [reason, expected] of cases) {
    const v = view(reason);
    same(v.unresolvedReason, expected, reason);
    clean(v, secrets, reason);
  }
});

check("a password full of RegExp characters is replaced literally", () => {
  const url = "rtsp://admin:pa$$.w*rd@10.0.0.12/x";
  const v = cameraView({ cameraId: "cam-5", url }, { kind: "unresolved", reason: "rejected pa$$.w*rd twice: pa$$.w*rd" });
  same(v.unresolvedReason, "rejected *** twice: ***", "literal");
  same(cameraView({ cameraId: "cam-5", url }, { kind: "unresolved", reason: "rejected pa%24%24.w*rd" }).unresolvedReason,
    "rejected ***", "encoded");
  same(cameraView({ cameraId: "cam-5", url }, { kind: "unresolved", reason: "rejected paXXXwrd" }).unresolvedReason,
    "rejected paXXXwrd", "'.' and '*' are not wildcards");
});

check("a password under three characters is not scrubbed out of ordinary words", () => {
  const url = "rtsp://admin:ab@10.0.0.9/x";
  const v = cameraView({ cameraId: "cam-6", url }, { kind: "unresolved", reason: "unable to reach camera" });
  same(v.unresolvedReason, "unable to reach camera", "\"unable\" keeps its 'ab'");
  same(cameraView({ cameraId: "cam-6", url }, { kind: "unresolved", reason: `bad ${url}` }).unresolvedReason,
    "bad ***", "the url itself still goes");
});

check("an unparseable url gives no host or port, and is still scrubbed from the reason", () => {
  const url = "http://admin:hunter2@10.0.0.5/";
  const v = cameraView({ cameraId: "cam-7", url, host: "10.0.0.99" },
    { kind: "unresolved", reason: `cannot use ${url}` });
  same([v.host, v.port], [null, null], "not the configured host either: the url is what was configured");
  same(v.unresolvedReason, "cannot use ***", "reason");
  clean(v, ["hunter2", url], "unparseable");
});

check("unresolved: origin null, resolved false, the reason kept when it holds nothing secret", () => {
  const v = cameraView({ cameraId: "cam-8", host: "10.0.0.10", vendor: "axis" },
    { kind: "unresolved", reason: "no template for this vendor" });
  same([v.origin, v.resolved, v.unresolvedReason], [null, false, "no template for this vendor"], "unresolved");
});

check("THE FEARED ONE: the resolved url, which carries the real credentials, is never read", () => {
  const resolution = { kind: "ok", origin: "discovered", url: "rtsp://admin:s3cret-pw@10.9.9.9:9999/ch1" };
  const v = cameraView({ cameraId: "cam-9", host: "10.0.0.10", vendor: "hikvision", channel: 3 }, resolution);
  same([v.host, v.port, v.origin, v.resolved], ["10.0.0.10", null, "discovered", true], "from config only");
  clean(v, ["s3cret-pw", "10.9.9.9", "9999", "ch1", "admin"], "resolved url");
});

check("a blank url falls back to the host; a blank host is null", () => {
  same(cameraView({ cameraId: "c", url: "   ", host: "10.0.0.11" }, OK).host, "10.0.0.11", "blank url");
  same(cameraView({ cameraId: "c", url: null, host: "10.0.0.11" }, OK).host, "10.0.0.11", "null url");
  same(cameraView({ cameraId: "c", host: "" }, OK).host, null, "blank host");
  same(cameraView({ cameraId: "c", host: "  " }, OK).host, null, "whitespace host");
  same(cameraView({ cameraId: "c" }, OK).host, null, "neither");
});

check("THE FEARED ONE: blanks stay blank — no channel 1, no bitrate 0, no vendor 'generic'", () => {
  const v = cameraView({ cameraId: "cam-10", host: "10.0.0.12" }, OK);
  same([v.name, v.vendor, v.channel, v.bitrateKbps, v.port], [null, null, null, null, null], "all null");
  const n = cameraView({ cameraId: "cam-10", host: "10.0.0.12", name: null, vendor: null, channel: null,
    bitrateKbps: null }, OK);
  same([n.name, n.vendor, n.channel, n.bitrateKbps], [null, null, null, null], "explicit nulls");
  same(cameraView({ cameraId: "cam-10", host: "h", channel: 0 }, OK).channel, 0, "a real 0 is kept");
});

report("cameraView");
