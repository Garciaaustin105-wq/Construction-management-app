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
      channel: 1,
      origin: "discovered",
    }),
    cam("cam2-sub", {
      host: "192.168.1.64",
      port: 554,
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
  same(device.deviceId, "host:192.168.1.64", "deviceId");
  same(device.host, "192.168.1.64", "host");
  same(device.vendor, "hikvision", "vendor");
  same(device.label, "192.168.1.64", "label falls back to the host");
  same(device.streams.map((s) => s.cameraId), ["cam1-main", "cam2-sub"], "streams sorted by cameraId");
});

// b) host is the grouping key; different hosts never merge.
check("two different hosts stay two devices", () => {
  const devices = groupCamerasByDevice([
    cam("cam1-main", { host: "192.168.1.64" }),
    cam("cam2-main", { host: "192.168.1.65" }),
  ]);
  if (devices.length !== 2) {
    throw new Error(`expected 2 devices, got ${devices.length}`);
  }
  same(devices.map((d) => d.deviceId), ["host:192.168.1.64", "host:192.168.1.65"], "deviceIds");
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
    cam("cam1-main", { vendor: "hikvision", host: "192.168.1.64" }),
    cam("cam2-sub", { vendor: "dahua", host: "192.168.1.64" }),
  ];
  same(firstDeviceOf(groupCamerasByDevice(makePair())).vendor, null, "vendor is null when streams disagree");
  same(firstDeviceOf(groupCamerasByDevice(makePair().reverse())).vendor, null, "still null with the streams reversed");
});

// e) label: first non-blank name, else host, else deviceId.
check("label falls back name -> host -> deviceId, blank names skipped", () => {
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam1-main", { name: "Front door", host: "192.168.1.64" })])).label,
    "Front door",
    "non-blank name wins",
  );
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam1-main", { name: "   ", host: "192.168.1.64" })])).label,
    "192.168.1.64",
    "whitespace-only name must not win",
  );
  same(
    firstDeviceOf(groupCamerasByDevice([cam("cam1-main", { host: "192.168.1.64" })])).label,
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
      cam("cam1-main", { name: "   ", host: "10.0.0.5" }),
      cam("cam2-sub", { name: "Back door", host: "10.0.0.5" }),
    ])).label,
    "Back door",
    "first non-blank name across the sorted streams wins",
  );
});

// f) one broken stream means the device is not fully healthy.
check("one unresolved stream makes the whole device unresolved", () => {
  const device = firstDeviceOf(groupCamerasByDevice([
    cam("cam1-main", { host: "192.168.1.64" }),
    cam("cam2-sub", { host: "192.168.1.64", resolved: false, unresolvedReason: "timeout" }),
  ]));
  same(device.resolved, false, "resolved");
  same(device.unresolvedCount, 1, "unresolvedCount");
});

// g) grouping must never reorder or rewrite the caller's data.
check("the input is not mutated", () => {
  const cameras = [
    cam("cam2-sub", { host: "192.168.1.64", port: 554, origin: "manual_url" }),
    cam("cam1-main", { vendor: "hikvision", host: "192.168.1.64", channel: 1, origin: "discovered" }),
  ];
  const snapshot = JSON.parse(JSON.stringify(cameras));
  groupCamerasByDevice(cameras);
  same(cameras, snapshot, "input deep-equals its pre-call snapshot");
  same(cameras.map((c) => c.cameraId), ["cam2-sub", "cam1-main"], "caller's array order untouched");
});

// h) same cameras, different input order, identical output.
check("output ordering is deterministic regardless of input order", () => {
  const first = groupCamerasByDevice([
    cam("cam2-sub", { host: "192.168.1.64" }),
    cam("cam1-main", { host: "192.168.1.64" }),
    cam("cam3-main", { host: "10.0.0.9", name: "Alpha" }),
  ]);
  const second = groupCamerasByDevice([
    cam("cam3-main", { host: "10.0.0.9", name: "Alpha" }),
    cam("cam1-main", { host: "192.168.1.64" }),
    cam("cam2-sub", { host: "192.168.1.64" }),
  ]);
  same(second, first, "same cameras in a different order produce the same devices");
  same(first.map((d) => d.label), ["192.168.1.64", "Alpha"], "devices sorted by label");
  same(first[0]?.streams.map((s) => s.cameraId), ["cam1-main", "cam2-sub"], "streams sorted within the device");
});

// i) nothing in, nothing out.
check("empty input yields an empty device list", () => {
  same(groupCamerasByDevice([]), [], "empty in, empty out");
});

report("cameraGroups");
