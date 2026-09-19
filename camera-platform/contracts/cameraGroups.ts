/**
 * One physical camera exposes several RTSP streams -- a main stream for
 * recording and a sub stream for live preview -- but the camera list
 * endpoint reports each stream as an independent entry. Rendering that
 * list directly puts two tiles on the operator's wall for every real
 * camera, so the streams have to be folded back into the devices they
 * belong to before they reach the grid.
 *
 * Streams of one camera share address, port, and channel. A DVR's cameras
 * share only the address; each has its own channel. When a stream's channel
 * cannot be told, it stands alone — an extra tile is obviously wrong and gets
 * noticed, while a hidden camera looks fine and gets missed. The cameraId
 * must never be a grouping key — names like "cam1-main" are a site naming
 * convention, not a contract, and grouping on a substring would look
 * plausible while silently merging unrelated cameras.
 *
 * A null host is unknown, not "the same unknown": two entries without a
 * host cannot be proven to be one device, so each stands alone. A null
 * sourceChannel means the channel could not be determined, so it also
 * stands alone.
 *
 * Where streams disagree, the device reports the disagreement instead of
 * resolving it: conflicting vendors collapse to null rather than to
 * whichever stream happened to come first. The label is the one place a
 * preference is allowed, because it exists for operators -- a readable
 * name beats the host, which beats the synthetic deviceId, but a blank
 * name is no name at all and must not win.
 */
import type { CameraView } from "./cameraView.js";
import type { Vendor } from "./camera.js";

export interface CameraDevice {
  deviceId: string;
  host: string | null;
  channel: number | null;
  vendor: Vendor | null;
  label: string;
  streams: CameraView[];
  resolved: boolean;
  unresolvedCount: number;
}

/**
 * Folds stream-level entries into device-level entries. The input is
 * treated as read-only: nothing is sorted in place, no CameraView is
 * modified, and the returned streams are the caller's own objects.
 */
export function groupCamerasByDevice(cameras: readonly CameraView[]): CameraDevice[] {
  // One bucket per device. The address and channel travel with the bucket, so
  // nothing is ever recovered by taking a key string back apart.
  const buckets = new Map<string, { host: string | null; channel: number | null; streams: CameraView[] }>();
  for (const camera of cameras) {
    const keyed = camera.host !== null && camera.sourceChannel !== null;
    // A missing port is the RTSP default: a camera configured by address has
    // no port of its own, and the recorder opens 554.
    const deviceId = keyed
      ? `device:${camera.host}:${camera.port ?? 554}:${camera.sourceChannel}`
      : `camera:${camera.cameraId}`;
    const bucket = buckets.get(deviceId);
    if (bucket === undefined) {
      // A stream that stands alone still reports the address and channel it
      // has: standing alone means not merged, not anonymous.
      buckets.set(deviceId, { host: camera.host, channel: camera.sourceChannel, streams: [camera] });
    } else {
      bucket.streams.push(camera);
    }
  }

  const devices: CameraDevice[] = [];
  for (const [deviceId, bucket] of buckets) {
    devices.push(buildDevice(deviceId, bucket.host, bucket.channel, bucket.streams));
  }

  // Labels need the whole list: an address shared by two or more devices has
  // to say which camera behind it each one is.
  const perHost = new Map<string, number>();
  for (const device of devices) {
    if (device.host !== null) perHost.set(device.host, (perHost.get(device.host) ?? 0) + 1);
  }
  for (const device of devices) {
    const shared = device.host !== null && (perHost.get(device.host) ?? 0) >= 2;
    device.label = deviceLabel(device, shared);
  }

  devices.sort(byLabelThenDeviceId);
  return devices;
}

function buildDevice(
  deviceId: string,
  host: string | null,
  channel: number | null,
  streams: readonly CameraView[],
): CameraDevice {
  const sorted = [...streams].sort(byCameraId);

  let unresolvedCount = 0;
  for (const stream of sorted) {
    if (!stream.resolved) {
      unresolvedCount += 1;
    }
  }

  return {
    deviceId,
    host,
    channel,
    vendor: deviceVendor(sorted),
    label: "", // set by groupCamerasByDevice, which alone can see every device on an address
    streams: sorted,
    resolved: unresolvedCount === 0,
    unresolvedCount,
  };
}

function deviceVendor(streams: readonly CameraView[]): Vendor | null {
  let vendor: Vendor | null = null;
  for (const stream of streams) {
    if (stream.vendor === null) {
      continue;
    }
    if (vendor === null) {
      vendor = stream.vendor;
    } else if (vendor !== stream.vendor) {
      return null;
    }
  }
  return vendor;
}

function deviceLabel(device: CameraDevice, hostShared: boolean): string {
  for (const stream of device.streams) {
    if (stream.name !== null && stream.name.trim() !== "") {
      return stream.name;
    }
  }
  if (device.host === null) return device.deviceId;
  if (!hostShared) return device.host;
  // Several cameras behind one address: the channel says which, and when the
  // channel is unknown the stream's own id is the only honest name left.
  return device.channel !== null
    ? `${device.host} ch ${device.channel}`
    : `${device.host} ${device.streams[0]?.cameraId ?? device.deviceId}`;
}

function byCameraId(a: CameraView, b: CameraView): number {
  if (a.cameraId < b.cameraId) return -1;
  if (a.cameraId > b.cameraId) return 1;
  return 0;
}

function byLabelThenDeviceId(a: CameraDevice, b: CameraDevice): number {
  const labelCmp = a.label.localeCompare(b.label, "en", { numeric: true });
  if (labelCmp !== 0) return labelCmp;
  // Fallback to deviceId comparison.
  if (a.deviceId < b.deviceId) return -1;
  if (a.deviceId > b.deviceId) return 1;
  return 0;
}
