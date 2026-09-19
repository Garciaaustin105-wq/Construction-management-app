import { groupCamerasByDevice } from "../dist/cameraGroups.js";
import { check, same, report } from "./_assert.mjs";

console.log("cameraGroups");

// Minimal CameraView factory: every field starts at its "nothing known"
// default so each case only spells out what it is actually about.
function cam(cameraId, over = {}) {
  return {
    cameraId,
    name: null,
    vendor: null,
    host: null,
    port: null,
    channel: null,
    sourceChannel: null,
    origin: null,
    resolved: true,
    unresolvedReason: null,
    bitrateKbps: null,
    measuredKbps: null,
    ...over,
  };
}

function firstDeviceOf(devices) {
  const device = devices[0];
  if (device === undefined) {
    throw new Error("expected at least one device, got none");
  }
  return device;
}

// a) the payload that started it: two streams, one host, ONE device.
check("two streams on one host collapse to exactly one device", () => {
  const devices = groupCamerasByDevice([
    cam("cam1-main", {
      vendor: "hikvision",
      host: "192.168.1.64",
      port: 554,
      sourceChannel: 1,
      channel: 1,
      origin: "discovered",
    }),
    cam("cam2-sub", {
      host: "192.168.1.64",
      port: 554,
      sourceChannel: 1,
      origin: "manual_url",
    }),
  ]);
  if (devices.length !== 1) {
    throw new Error(`expected 1 device, got ${devices.length}`);
  }
  const device = firstDeviceOf(devices);
  if (device.streams.length !== 2) {
    throw new Error(`expected both streams on the device, got ${device.streams.length}`);
  }
  same(device.deviceId, "device:192.168.1.64:554:1", "deviceId");
  same(device.host, "192.168.1.64", "host");
  same(device.channel, 1, "channel");
  same(device.vendor, "hikvision", "vendor");
  same(device.label, "192.168.1.64", "label falls back to the host when only one device per host");
  same(device.streams.map((s) => s.cameraId), ["cam1-main", "cam2-sub"], "streams sorted by cameraId");
});

// b) host is the grouping key; different hosts never merge.
check("two different hosts stay two devices", () => {
  const devices = groupCamerasByDevice([
    cam("cam1-main", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
    cam("cam2-main", { host: "192.168.1.65", port: 554, sourceChannel: 1 }),
  ]);
  if (devices.length !== 2) {
    throw new Error(`expected 2 devices, got ${devices.length}`);
  }
  same(devices.map((d) => d.deviceId), ["device:192.168.1.64:554:1", "device:192.168.1.65:554:1"], "deviceIds");
  same(devices.map((d) => d.streams.length), [1, 1], "one stream per device");
});

// c) null host is unknown, and two unknowns are not a match.
check("host-null cameras each stand alone, never grouped together", () => {
  const devices = groupCamerasByDevice([cam("cam2-sub"), cam("cam1-main")]);
  if (devices.length !== 2) {
    throw new Error(`expected 2 devices for 2 host-null cameras, got ${devices.length}`);
  }
  same(devices.map((d) => d.deviceId), ["camera:cam1-main", "camera:cam2-sub"], "deviceIds");
  same(devices.map((d) => d.host), [null, null], "hosts");

  const mixed = groupCamerasByDevice([cam("cam2-sub"), cam("cam3-main", { host: "10.0.0.9" })]);
  if (mixed.length !== 2) {
    throw new Error(`a host-null camera must not join a known host, got ${mixed.length} devices`);
  }
});

// d) disagreement is information; the first vendor must not win.
check("disagreeing vendors give vendor null, never the first vendor", () => {
  const makePair = () => [
    cam("cam1-main", { vendor: "hikvision", host: "192.168.1.64", port: 554, sourceChannel: 1 }),
    cam("cam2-sub", { vendor: "dahua", host: "192.168.1.64", port: 554, sourceChannel: 1 }),
  ];
  same(firstDeviceOf(groupCamerasByDevice(makePair())).vendor, null, "vendor is null when streams disagree");
  same(firstDeviceOf(groupCamerasByDevice(makePair().reverse())).vendor, null, "still null with the streams reversed");
});

// e) label: first non-blank name, else host, else deviceId.
check("label falls back name -> host -> deviceId, blank names skipped", () => {
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam1-main", { name: "Front door", host: "192.168.1.64", port: 554, sourceChannel: 1 })])).label,
    "Front door",
    "non-blank name wins",
  );
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam1-main", { name: "   ", host: "192.168.1.64", port: 554, sourceChannel: 1 })])).label,
    "192.168.1.64",
    "whitespace-only name must not win",
  );
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam1-main", { host: "192.168.1.64", port: 554, sourceChannel: 1 })])).label,
    "192.168.1.64",
    "host wins when name is null",
  );
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam2-sub")])).label,
    "camera:cam2-sub",
    "deviceId wins when name and host are both missing",
  );
  same(
    firstDeviceOf(groupCamerasByDevice([
      cam("cam1-main", { name: "   ", host: "10.0.0.5", port: 554, sourceChannel: 1 }),
      cam("cam2-sub", { name: "Back door", host: "10.0.0.5", port: 554, sourceChannel: 1 }),
    ])).label,
    "Back door",
    "first non-blank name across the sorted streams wins",
  );
});

// f) one broken stream means the device is not fully healthy.
check("one unresolved stream makes the whole device unresolved", () => {
  const device = firstDeviceOf(groupCamerasByDevice([
    cam("cam1-main", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
    cam("cam2-sub", { host: "192.168.1.64", port: 554, sourceChannel: 1, resolved: false, unresolvedReason: "timeout" }),
  ]));
  same(device.resolved, false, "resolved");
  same(device.unresolvedCount, 1, "unresolvedCount");
});

// g) grouping must never reorder or rewrite the caller's data.
check("the input is not mutated", () => {
  const cameras = [
    cam("cam2-sub", { host: "192.168.1.64", port: 554, sourceChannel: 1, origin: "manual_url" }),
    cam("cam1-main", { vendor: "hikvision", host: "192.168.1.64", port: 554, sourceChannel: 1, channel: 1, origin: "discovered" }),
  ];
  const snapshot = JSON.parse(JSON.stringify(cameras));
  groupCamerasByDevice(cameras);
  same(cameras, snapshot, "input deep-equals its pre-call snapshot");
  same(cameras.map((c) => c.cameraId), ["cam2-sub", "cam1-main"], "caller's array order untouched");
});

// h) same cameras, different input order, identical output.
check("output ordering is deterministic regardless of input order", () => {
  const first = groupCamerasByDevice([
    cam("cam2-sub", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
    cam("cam1-main", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
    cam("cam3-main", { host: "10.0.0.9", port: 554, sourceChannel: 1, name: "Alpha" }),
  ]);
  const second = groupCamerasByDevice([
    cam("cam3-main", { host: "10.0.0.9", port: 554, sourceChannel: 1, name: "Alpha" }),
    cam("cam1-main", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
    cam("cam2-sub", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
  ]);
  same(second, first, "same cameras in a different order produce the same devices");
  same(first.map((d) => d.label), ["192.168.1.64", "Alpha"], "devices sorted by label");
  same(first[0]?.streams.map((s) => s.cameraId), ["cam1-main", "cam2-sub"], "streams sorted within the device");
});

// i) nothing in, nothing out.
check("empty input yields an empty device list", () => {
  same(groupCamerasByDevice([]), [], "empty in, empty out");
});

// Streams of one physical camera share address, port AND channel. A DVR's
// cameras share only the address. When the channel cannot be told, a stream
// stands alone: an extra tile is obviously wrong and gets noticed, a hidden
// camera looks fine and gets missed.

check("THE FEARED ONE: sixteen channels behind one DVR are sixteen cameras", () => {
  const views = [];
  for (let c = 1; c <= 16; c++) views.push(cam("dvr-ch" + c, { host: "10.0.0.9", port: 554, sourceChannel: c }));
  const devices = groupCamerasByDevice(views);
  same(devices.length, 16, "one device per channel, not one for the whole DVR");
  same(new Set(devices.map((d) => d.deviceId)).size, 16, "each with its own id");
});

check("a DVR channel's main and sub stream are still one camera", () => {
  const devices = groupCamerasByDevice([
    cam("ch1-main", { host: "10.0.0.9", port: 554, sourceChannel: 1 }),
    cam("ch1-sub", { host: "10.0.0.9", port: 554, sourceChannel: 1 }),
    cam("ch2-main", { host: "10.0.0.9", port: 554, sourceChannel: 2 }),
  ]);
  same(devices.length, 2, "channel 1's two streams fold; channel 2 stands apart");
  same(devices.map((d) => d.streams.map((s) => s.cameraId)), [["ch1-main", "ch1-sub"], ["ch2-main"]],
    "which streams went where");
});

check("THE FEARED ONE: a stream whose channel is unknown never merges, even on a shared address", () => {
  const views = [];
  for (let c = 3; c <= 16; c++) views.push(cam("cam" + c, { host: "127.0.0.1", port: 8554, sourceChannel: null }));
  same(groupCamerasByDevice(views).length, 14, "14 unknown streams on one address are 14 tiles, not one");
});

check("the same address and channel on different ports are different cameras", () => {
  // Two cameras port-forwarded through one public address.
  same(groupCamerasByDevice([
    cam("a", { host: "203.0.113.5", port: 5541, sourceChannel: 1 }),
    cam("b", { host: "203.0.113.5", port: 5542, sourceChannel: 1 }),
  ]).length, 2, "different ports");
  // A camera configured by address has no port of its own: the recorder uses 554.
  same(groupCamerasByDevice([
    cam("main", { host: "192.168.1.64", port: null, sourceChannel: 1 }),
    cam("sub", { host: "192.168.1.64", port: 554, sourceChannel: 1 }),
  ]).length, 1, "a missing port is the RTSP default 554, so these are one camera");
});

check("nameless cameras behind one address are told apart by channel, in channel order", () => {
  const devices = groupCamerasByDevice([10, 2, 1].map((c) =>
    cam("dvr-" + c, { host: "10.0.0.9", port: 554, sourceChannel: c })));
  same(devices.map((d) => d.label), ["10.0.0.9 ch 1", "10.0.0.9 ch 2", "10.0.0.9 ch 10"],
    "labelled by channel, and ch 2 before ch 10");
  // A lone camera keeps its plain address: no "ch 1" on every ordinary camera.
  same(groupCamerasByDevice([cam("x", { host: "10.0.0.7", port: 554, sourceChannel: 1 })])[0].label, "10.0.0.7",
    "a lone camera");
});

check("THE FEARED ONE: a stream that stands alone keeps its address, and a shared address says which stream", () => {
  // Standing alone means not merged, not anonymous. Fourteen tiles all
  // labelled "127.0.0.1" would be as useless as one.
  const devices = groupCamerasByDevice([
    cam("cam3", { host: "127.0.0.1", port: 8554, sourceChannel: null }),
    cam("cam4", { host: "127.0.0.1", port: 8554, sourceChannel: null }),
  ]);
  same(devices.map((d) => d.host), ["127.0.0.1", "127.0.0.1"], "each still reports its address");
  same(devices.map((d) => d.channel), [null, null], "an unknown channel stays unknown");
  same(devices.map((d) => d.label), ["127.0.0.1 cam3", "127.0.0.1 cam4"], "and each tile says which stream it is");
});

report("cameraGroups");
