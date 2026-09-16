/**
 * One physical camera exposes several RTSP streams -- a main stream for
 * recording and a sub stream for live preview -- but the camera list
 * endpoint reports each stream as an independent entry. Rendering that
 * list directly puts two tiles on the operator's wall for every real
 * camera, so the streams have to be folded back into the devices they
 * belong to before they reach the grid.
 *
 * `host` is the only field two entries of the same physical camera are
 * guaranteed to share, so it is the grouping key, compared as an exact
 * string. Everything else is per-stream: vendor and name describe one
 * stream's configuration, not the device. The cameraId in particular must
 * never become a grouping key -- names like "cam1-main" are a site naming
 * convention, not a contract, and grouping on a substring of them would
 * look plausible while silently merging unrelated cameras.
 *
 * A null host is unknown, not "the same unknown": two entries without a
 * host cannot be proven to be one device, so each stands alone.
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
  const byHost = new Map<string, CameraView[]>();
  const hostless: CameraView[] = [];

  for (const camera of cameras) {
    if (camera.host === null) {
      hostless.push(camera);
      continue;
    }
    const bucket = byHost.get(camera.host);
    if (bucket === undefined) {
      byHost.set(camera.host, [camera]);
    } else {
      bucket.push(camera);
    }
  }

  const devices: CameraDevice[] = [];
  for (const [host, streams] of byHost) {
    devices.push(buildDevice("host:" + host, host, streams));
  }
  for (const camera of hostless) {
    devices.push(buildDevice("camera:" + camera.cameraId, null, [camera]));
  }

  devices.sort(byLabelThenDeviceId);
  return devices;
}

function buildDevice(
  deviceId: string,
  host: string | null,
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
    vendor: deviceVendor(sorted),
    label: deviceLabel(sorted, host, deviceId),
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

function deviceLabel(
  streams: readonly CameraView[],
  host: string | null,
  deviceId: string,
): string {
  for (const stream of streams) {
    if (stream.name !== null && stream.name.trim() !== "") {
      return stream.name;
    }
  }
  return host !== null ? host : deviceId;
}

function byCameraId(a: CameraView, b: CameraView): number {
  if (a.cameraId < b.cameraId) return -1;
  if (a.cameraId > b.cameraId) return 1;
  return 0;
}

function byLabelThenDeviceId(a: CameraDevice, b: CameraDevice): number {
  if (a.label < b.label) return -1;
  if (a.label > b.label) return 1;
  if (a.deviceId < b.deviceId) return -1;
  if (a.deviceId > b.deviceId) return 1;
  return 0;
}
