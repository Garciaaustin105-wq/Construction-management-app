/**
 * Health history: the graphs on the System page's new "History" section
 * (HEALTH-HISTORY-SPEC.md). This is the sampler's arithmetic and the reader's
 * bucketing — never the sampler itself. agent/api-server.mjs reads
 * /proc/stat, /proc/loadavg, /proc/meminfo, hwmon and thermal_zone files, and
 * the segment index; this file only turns what it already read into a
 * number, a reason, or a bucket.
 *
 * Pure. No fs, no clock of its own, no node:sqlite: every reading, every
 * "now", and every stored sample is handed in already read. That is what
 * lets this harness run on a Windows dev box, where every one of those Linux
 * files is simply absent (build rule 20) — the caller passes null or an
 * empty listing, and every function here answers with a reason rather than
 * throwing.
 *
 * THE FEARED FAILURE, three times over:
 *  - a wrapped or reset counter (CPU jiffies after a reboot, same shape as
 *    the network byte counters in contracts/networkView.ts) read as a
 *    negative or a zero busy percentage. It must read "no value" instead.
 *  - an empty bucket rendered as "0" rather than a break in the line — the
 *    same blank-is-not-a-zero failure this codebase keeps naming (build
 *    rule 5), now for a MEDIAN instead of a single measurement.
 *  - a mean standing in for a median (build rule 14): one camera's segment
 *    twice the size of the rest would drag a mean bitrate up for the whole
 *    bucket; the median ignores it, which is the point.
 */

import { parseUtc, toUtc, type EpochMs } from "./time.js";

// ---------------------------------------------------------------------------
// Small helpers shared by every "many numbers -> one number" function below.
// Rule 14: medians, never means.
// ---------------------------------------------------------------------------

function medianOf(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

// ---------------------------------------------------------------------------
// CPU: /proc/stat's aggregate "cpu " line, and the busy percentage between
// two readings a sampler tick (60s) apart.
//
// THE FEARED FAILURE: a reboot resets every jiffy counter to a small number.
// Subtracting the new (small) reading from the old (large) one the way
// contracts/networkView.ts's counterRate guards against gives a negative
// delta that a careless caller turns into a negative, or a rounded-to-zero,
// busy percentage — both are wrong AND look plausible on a graph. This
// reports "counter_reset" instead, exactly like counterRate does for a NIC
// counter, and writes no row for that minute (spec: "writes nothing").
// ---------------------------------------------------------------------------

/** Jiffies since boot, as /proc/stat's own field order gives them. */
export interface CpuStatSample {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

/**
 * Parses the single aggregate line (`cpu  10132153 290696 ...`), never a
 * per-core `cpu0`/`cpu1` line. Missing fields beyond `idle` (iowait, irq,
 * softirq, steal did not exist on very old kernels) default to 0 — they are
 * genuinely absent, not unmeasured, and 0 jiffies of steal time is a real
 * fact on a kernel that never reports it.
 *
 * Returns null — never throws — for anything that is not this file's shape:
 * no "cpu " line at all, or one with fewer than the four fields every kernel
 * has always had (user, nice, system, idle).
 */
export function parseProcStat(text: string): CpuStatSample | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("cpu ")) continue;
    const fields = line
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((s) => Number(s));
    if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
    return {
      user: fields[0] as number,
      nice: fields[1] as number,
      system: fields[2] as number,
      idle: fields[3] as number,
      iowait: fields[4] ?? 0,
      irq: fields[5] ?? 0,
      softirq: fields[6] ?? 0,
      steal: fields[7] ?? 0,
    };
  }
  return null;
}

function cpuTotalJiffies(s: CpuStatSample): number {
  return s.user + s.nice + s.system + s.idle + s.iowait + s.irq + s.softirq + s.steal;
}

export type CpuPercentResult =
  | { kind: "ok"; percent: number }
  | { kind: "no_previous"; reason: string }
  | { kind: "counter_reset"; reason: string };

/**
 * `prev` is the reading from one sampler tick ago (60s), or null when this
 * is the very first tick this process has ever taken — there is nothing to
 * subtract from yet, exactly like counterRate's first-sample case in
 * contracts/networkView.ts. `next` is the current reading.
 *
 * The result is clamped to [0, 100]: jiffy accounting across cores can round
 * a hair past either end, and a graph showing "100.4%" or "-0.2%" looks like
 * a bug in this function rather than the rounding it actually is.
 */
export function cpuPercent(prev: CpuStatSample | null, next: CpuStatSample): CpuPercentResult {
  if (prev === null) {
    return { kind: "no_previous", reason: "first reading; nothing to compare it against yet" };
  }

  const totalPrev = cpuTotalJiffies(prev);
  const totalNext = cpuTotalJiffies(next);
  const idlePrev = prev.idle + prev.iowait;
  const idleNext = next.idle + next.iowait;

  // Total must strictly increase, and idle must not decrease more than total
  // does. Either failing means the counters did not advance the way a live
  // kernel's jiffy counters always do: a reboot, or two readings with no
  // real time between them. Both write nothing, never a guess.
  if (totalNext <= totalPrev || idleNext < idlePrev) {
    return {
      kind: "counter_reset",
      reason: `CPU counters went from ${totalPrev} to ${totalNext} total jiffies; the machine likely rebooted`,
    };
  }

  const totalDelta = totalNext - totalPrev;
  const idleDelta = idleNext - idlePrev;
  const busyFraction = (totalDelta - idleDelta) / totalDelta;
  const percent = Math.max(0, Math.min(100, busyFraction * 100));
  return { kind: "ok", percent };
}

// ---------------------------------------------------------------------------
// Load average and memory: /proc/loadavg and /proc/meminfo, both plain text
// on every Linux box and both simply absent on the Windows dev box.
// ---------------------------------------------------------------------------

/**
 * `/proc/loadavg` is one line: "0.52 0.58 0.59 2/389 12345". Only load1 (the
 * first field) is kept — load5 and load15 are not part of this spec's
 * series. Returns null for anything that does not parse, never a fabricated
 * 0 (an idle box and an unreadable file must not look the same).
 */
export function parseProcLoadavg(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const first = trimmed.split(/\s+/)[0] as string;
  const load1 = Number(first);
  return Number.isFinite(load1) ? load1 : null;
}

export interface MeminfoResult {
  memUsedMiB: number;
  memAvailableMiB: number;
}

/**
 * `/proc/meminfo` is a colon-separated table, values in kibibytes despite
 * the "kB" label (Linux has always meant KiB there). MemTotal - MemAvailable
 * is "used", per the spec's own words — never MemFree, which excludes the
 * page cache and makes a perfectly healthy box look nearly out of memory.
 *
 * Returns null when either field is missing, never a used figure computed
 * from only one of them.
 */
export function parseProcMeminfo(text: string): MeminfoResult | null {
  let totalKib: number | null = null;
  let availableKib: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\w+):\s*(\d+)\s*kB\s*$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1] as string;
    const value = Number(match[2] as string);
    if (key === "MemTotal") totalKib = value;
    else if (key === "MemAvailable") availableKib = value;
  }
  if (totalKib === null || availableKib === null) return null;
  const usedKib = totalKib - availableKib;
  return { memUsedMiB: usedKib / 1024, memAvailableMiB: availableKib / 1024 };
}

// ---------------------------------------------------------------------------
// Temperature source: hwmon coretemp "Package id 0", then a thermal_zone of
// type x86_pkg_temp, then the hottest thermal_zone. The spec requires BOTH
// the value and which source produced it, because a page that just says
// "42°C" invites the question "of what" the moment two sources disagree.
// ---------------------------------------------------------------------------

/** One hwmon input, as read from `/sys/class/hwmon/hwmonN/name` (the chip)
 *  and a `tempN_label` / `tempN_input` pair. */
export interface HwmonTempInput {
  chip: string;
  label: string;
  tempC: number;
}

/** One thermal zone, as read from `/sys/class/thermal/thermal_zoneN/type`
 *  and its sibling `temp` file. */
export interface ThermalZoneInput {
  zone: string;
  type: string;
  tempC: number;
}

export type TempSourceResult =
  | { kind: "measured"; tempC: number; source: string }
  | { kind: "unmeasured"; reason: string };

/**
 * Preference order, per the spec:
 *  1. hwmon chip "coretemp", input labelled "Package id 0" — the package
 *     sensor Intel's driver exposes, when it is present.
 *  2. a thermal_zone whose type is exactly "x86_pkg_temp" — the same sensor,
 *     reached the other way, on boxes without the hwmon coretemp driver.
 *  3. the HOTTEST thermal_zone of any type — a box with neither of the above
 *     (a different CPU vendor, a stripped-down kernel) still gets a number,
 *     because "no temperature at all" is worse than "not necessarily the
 *     package sensor", as long as which one it was is shown alongside it.
 * Nothing at all: unmeasured, with a reason — never a fabricated 0°C, which
 * on this chart would read as "frozen", not "not measured".
 */
export function chooseTempSource(
  hwmon: readonly HwmonTempInput[],
  thermalZones: readonly ThermalZoneInput[],
): TempSourceResult {
  const coretempPackage = hwmon.find((h) => h.chip === "coretemp" && h.label === "Package id 0");
  if (coretempPackage !== undefined) {
    return { kind: "measured", tempC: coretempPackage.tempC, source: "hwmon coretemp Package id 0" };
  }

  const pkgZone = thermalZones.find((z) => z.type === "x86_pkg_temp");
  if (pkgZone !== undefined) {
    return { kind: "measured", tempC: pkgZone.tempC, source: "thermal_zone x86_pkg_temp" };
  }

  if (thermalZones.length > 0) {
    const hottest = thermalZones.reduce((hot, z) => (z.tempC > hot.tempC ? z : hot));
    return { kind: "measured", tempC: hottest.tempC, source: `hottest thermal_zone (${hottest.type})` };
  }

  return { kind: "unmeasured", reason: "no hwmon coretemp, x86_pkg_temp, or any thermal_zone found" };
}

// ---------------------------------------------------------------------------
// Per-camera recorded bitrate: segments sealed inside the sampler's 60s
// window, from the index -- the same segment shape contracts/segment.ts
// already uses (bytes, startUtc, endUtc), not the camera's configured rate
// (build rule 8: seed structure, never values -- and a request is not a
// measurement regardless).
// ---------------------------------------------------------------------------

export interface SealedSegmentInput {
  bytes: number;
  startUtc: string;
  endUtc: string;
}

export type RecordedKbpsResult =
  | { kind: "measured"; kbps: number }
  | { kind: "unmeasured"; reason: string };

/**
 * kbps = total bytes of every segment that sealed this minute, times 8,
 * divided by their combined measured duration in seconds, divided by 1000.
 * An empty list -- nothing sealed this minute -- is unmeasured, never a 0
 * (spec: "a minute with no sealed segment writes nothing").
 */
export function recordedKbps(segments: readonly SealedSegmentInput[]): RecordedKbpsResult {
  if (segments.length === 0) {
    return { kind: "unmeasured", reason: "no segment sealed in this window" };
  }
  let totalBytes = 0;
  let totalSeconds = 0;
  for (const s of segments) {
    totalBytes += s.bytes;
    totalSeconds += (parseUtc(s.endUtc) - parseUtc(s.startUtc)) / 1000;
  }
  if (totalSeconds <= 0) {
    return { kind: "unmeasured", reason: "sealed segments in this window have no measurable duration" };
  }
  const kbps = (totalBytes * 8) / totalSeconds / 1000;
  return { kind: "measured", kbps };
}

// ---------------------------------------------------------------------------
// Recording and "recorder alive" state -- a 0/1 sample derived from a last-
// event timestamp, drawn later as a strip, never a line.
// ---------------------------------------------------------------------------

export type RecordingSampleValue = 0 | 1;

/**
 * 1 when something sealed within `thresholdSeconds` (default 120, per the
 * spec) of `atUtc`; 0 otherwise, including when nothing has ever sealed.
 * This is a real, always-answerable 0 or 1 -- unlike recordedKbps above, a
 * camera that has recorded nothing yet is genuinely "not recording right
 * now", not "unmeasured".
 */
export function recordingStateSample(
  lastSealedUtc: string | null,
  atUtc: string,
  thresholdSeconds = 120,
): RecordingSampleValue {
  if (lastSealedUtc === null) return 0;
  const deltaSeconds = (parseUtc(atUtc) - parseUtc(lastSealedUtc)) / 1000;
  return deltaSeconds <= thresholdSeconds ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Bucketing: GET /health/history's job. 24h -> 288 five-minute buckets; 7d ->
// 168 one-hour buckets. Each bucket is a MEDIAN of the samples that landed in
// it, with n the count, and n=0 is null -- never 0 (build rules 5 and 14).
// ---------------------------------------------------------------------------

export type HistoryRange = "24h" | "7d";

export const BUCKET_MS: Record<HistoryRange, number> = {
  "24h": 5 * 60 * 1000,
  "7d": 60 * 60 * 1000,
};

export const BUCKET_COUNT: Record<HistoryRange, number> = {
  "24h": 288,
  "7d": 168,
};

export interface SamplePoint {
  atUtc: string;
  value: number;
}

export interface Bucket {
  startUtc: string;
  /** Median of the samples in this bucket, or null when n is 0 -- a break
   *  in the line, never a point at 0. */
  median: number | null;
  n: number;
}

/**
 * THE FEARED FAILURE: a sample whose timestamp is exactly on a bucket
 * boundary landing in two buckets (double-counted, skewing both medians) or
 * in zero buckets (silently dropped). `Math.floor` puts a sample at exactly
 * `rangeStartUtc + k * bucketMs` into bucket k, and nowhere else: the bucket
 * it starts is a half-open interval `[start, start + bucketMs)`.
 *
 * Samples outside `[rangeStartUtc, rangeStartUtc + count * bucketMs)` are
 * dropped rather than clamped into the first or last bucket -- an out-of-
 * range sample belongs to a different graph, not this one's edge.
 */
export function bucketSamples(
  samples: readonly SamplePoint[],
  rangeStartUtc: string,
  range: HistoryRange,
): Bucket[] {
  const bucketMs = BUCKET_MS[range];
  const count = BUCKET_COUNT[range];
  const startMs = parseUtc(rangeStartUtc);

  const buckets: number[][] = Array.from({ length: count }, () => []);
  for (const sample of samples) {
    const t = parseUtc(sample.atUtc);
    const idx = Math.floor((t - startMs) / bucketMs);
    if (idx < 0 || idx >= count) continue;
    (buckets[idx] as number[]).push(sample.value);
  }

  return buckets.map((values, i) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      startUtc: toUtc(startMs + i * bucketMs),
      median: sorted.length === 0 ? null : medianOf(sorted),
      n: sorted.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Run-length spans for the on/off strips ("recording", "recorder running").
// A minute the sampler never took (the API service was down) is "no
// samples" -- a third state, never folded into "off" (spec: "the graph
// shows that as a gap. That is true: the NVR's own web service was down.").
// ---------------------------------------------------------------------------

export type StripState = "on" | "off" | "no samples";

export interface StripSample {
  atUtc: string;
  state: "on" | "off";
}

export interface StripSpan {
  fromUtc: string;
  toUtc: string;
  state: StripState;
}

/**
 * Walks `[rangeStartUtc, rangeEndUtc)` in `stepMs` increments (the sampler's
 * own tick, normally 60s), placing each known sample and filling every gap
 * -- before the first sample, between two samples more than `stepMs` apart,
 * and after the last one -- with "no samples". Adjacent points of the same
 * state are coalesced into one span, the same way
 * contracts/segment.ts's coalesceForDisplay merges a timeline for display.
 *
 * `samples` need not be sorted or deduplicated; a duplicate timestamp keeps
 * whichever copy is encountered first after sorting, since two samples for
 * the same instant is a caller bug this function should not have to guess
 * an answer to.
 */
export function buildStateSpans(
  samples: readonly StripSample[],
  rangeStartUtc: string,
  rangeEndUtc: string,
  stepMs: number,
): StripSpan[] {
  const startMs = parseUtc(rangeStartUtc);
  const endMs = parseUtc(rangeEndUtc);
  const sorted = [...samples]
    .filter((s) => {
      const t = parseUtc(s.atUtc);
      return t >= startMs && t < endMs;
    })
    .sort((a, b) => parseUtc(a.atUtc) - parseUtc(b.atUtc));

  const spans: StripSpan[] = [];
  const push = (fromMs: EpochMs, toMs: EpochMs, state: StripState) => {
    if (toMs <= fromMs) return;
    const prev = spans[spans.length - 1];
    if (prev !== undefined && prev.state === state && prev.toUtc === toUtc(fromMs)) {
      prev.toUtc = toUtc(toMs);
    } else {
      spans.push({ fromUtc: toUtc(fromMs), toUtc: toUtc(toMs), state });
    }
  };

  let cursor = startMs;
  for (const sample of sorted) {
    const t = parseUtc(sample.atUtc);
    if (t < cursor) continue; // duplicate/out-of-order timestamp: first copy wins
    if (t > cursor) push(cursor, t, "no samples");
    push(t, Math.min(t + stepMs, endMs), sample.state);
    cursor = Math.max(cursor, Math.min(t + stepMs, endMs));
  }
  if (cursor < endMs) push(cursor, endMs, "no samples");

  return spans;
}

// ---------------------------------------------------------------------------
// Range validation for GET /health/history?range=24h|7d.
// ---------------------------------------------------------------------------

export type HistoryRangeValidation =
  | { kind: "ok"; range: HistoryRange }
  | { kind: "invalid"; reason: string };

/** Anything other than exactly "24h" or "7d" -- including missing, empty,
 *  "24H", "1d", or a stray query-string array -- is a 400 (spec: "Any other
 *  range value is a 400."), never a silent default to one or the other. */
export function validateHistoryRange(raw: unknown): HistoryRangeValidation {
  if (raw === "24h" || raw === "7d") return { kind: "ok", range: raw };
  return { kind: "invalid", reason: `range must be "24h" or "7d", got ${JSON.stringify(raw)}` };
}
