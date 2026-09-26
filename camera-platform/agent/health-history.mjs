// agent/health-history.mjs
//
// I/O for the System page's History section (HEALTH-HISTORY-SPEC.md): the 60s
// sampler that reads /proc, /sys, statfs, the segment index and health.json,
// the <stateDir>/health-history.db store (node:sqlite, WAL), and the
// GET /health/history route's own read/bucket/assemble step. Every piece of
// arithmetic -- the busy-percent math, the temperature source's preference
// order, the median bucketing, the on/off run-length spans -- lives in
// contracts/healthHistory.ts (compiled to ../dist/healthHistory.js); this
// file only fetches what that file expects to be handed already read (build
// rules 1-2), the same split agent/network-facts.mjs keeps for the Network
// page, whose sampler pattern (unref()'d timers, a close hook, every source
// injectable) this file copies directly.
//
// LINUX-ONLY: /proc/stat, /proc/loadavg, /proc/meminfo, and the hwmon/
// thermal_zone files under /sys. None of them exist on the Windows dev box
// this harness runs on (build rule 20); every one of them is gated on
// `platform === 'linux'` and simply reads as "nothing to report" -- never a
// throw, never a zero standing in for a measurement never taken. statfs
// (the drive series) is NOT gated: it is a real, cross-platform Node API, and
// agent/healthfacts.mjs's storeFact() already runs it on both operating
// systems today.
//
// THE FEARED FAILURE this file is written against, by name: a camera's
// rtsp://user:pass@host/... , or config.json's own credentials, reaching the
// `subject` column, the sqlite file's bytes, or a log line. This file never
// imports resolveCameraUrl or reads a camera's `url`/`host` field at all --
// every camera subject it ever writes is a bare `cameraId`, the same
// identifier already public on /cameras and /events. Every other subject is
// "nvr", a network interface name (already public via /network), or --
// unlike /health's own `stores[].root`, which sends the configured path
// verbatim -- a store root's own LABEL (driveLabelsFor's basename, never the
// raw config.storeRoots path, which could carry an OS username): the spec's
// own words for `subject` (HEALTH-HISTORY-SPEC.md: "never a path with a user
// in it").

import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

import {
  parseProcStat,
  cpuPercent,
  parseProcLoadavg,
  parseProcMeminfo,
  chooseTempSource,
  recordedKbps,
  recordingStateSample,
  bucketSamples,
  buildStateSpans,
  BUCKET_MS,
  BUCKET_COUNT,
} from '../dist/healthHistory.js';
import { counterRate } from '../dist/networkView.js';
import { watchedMinutesForBuckets } from '../dist/activityMeasure.js';
import { cameraFacts, storeFact, recorderRunning } from './healthfacts.mjs';
import { listInterfaceNames, readCounterSample } from './network-facts.mjs';

const isLinux = (platform) => platform === 'linux';

export const HEALTH_HISTORY_DB_FILE = 'health-history.db';

export const SAMPLE_INTERVAL_MS = 60_000; // spec: "every 60 s"
export const RETENTION_DAYS = 8;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly, in batches
export const PRUNE_BATCH_SIZE = 5_000;
export const RECORDING_THRESHOLD_SECONDS = 120; // spec default for recordingStateSample

export const NVR_SUBJECT = 'nvr';

/** One fixed metric name per series (the `metric` column). `subject` carries
 *  which "nvr" / store root / camera / interface a row is about. */
export const METRIC = Object.freeze({
  CPU_PERCENT: 'cpuPercent',
  LOAD1: 'load1',
  MEM_USED_MIB: 'memUsedMiB',
  TEMP_C: 'tempC',
  DRIVE_USED_PCT: 'driveUsedPct',
  CAMERA_KBPS: 'recordedKbps',
  CAMERA_RECORDING: 'recording',
  // The activity page's own sample (ACTIVITY-PAGE-SPEC.md): 1 when
  // detect-health.json shows this camera's detector alive (a frame or a
  // gate window) within the last 120 s, 0 otherwise -- always written once
  // detect-health.json itself is readable and names this camera, exactly
  // like CAMERA_RECORDING above, and for the same reason: "not watching" is
  // a real, always-answerable fact, never an unmeasured blank BY ITSELF.
  // (Before this metric existed for a camera at all, its ABSENCE is what
  // /activity's watchMeasuredFromUtc / watchedMinutesFor below report as
  // truly unmeasured -- a missing row, not a stored 0.)
  CAMERA_DETECTING: 'detecting',
  RECORDER_RUNNING: 'recorderRunning',
  IFACE_RX_MBPS: 'rxMbps',
  IFACE_TX_MBPS: 'txMbps',
});

const UNIT = Object.freeze({
  [METRIC.CPU_PERCENT]: '%',
  [METRIC.LOAD1]: 'load average',
  [METRIC.MEM_USED_MIB]: 'MiB',
  [METRIC.TEMP_C]: '°C',
  [METRIC.DRIVE_USED_PCT]: '%',
  [METRIC.CAMERA_KBPS]: 'kbps',
  [METRIC.IFACE_RX_MBPS]: 'Mbps',
  [METRIC.IFACE_TX_MBPS]: 'Mbps',
});

// ---------------------------------------------------------------------------
// The store: <stateDir>/health-history.db. WAL, WITHOUT ROWID on the natural
// key -- the spec's own schema, verbatim.
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples(
  at_ms INTEGER, metric TEXT, subject TEXT, value REAL,
  PRIMARY KEY(metric, subject, at_ms)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_samples_at ON samples(at_ms);
-- Small, non-sample metadata that must outlive a process restart: today only
-- the temperature source label (a string, so it cannot live in the samples
-- table above, whose value column is REAL). Keyed by a fixed name, one row each.
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

/** The meta table's one key for chooseTempSource()'s label (spec: "Record
 *  which source was used, and show it under the chart"). */
const META_TEMP_SOURCE = 'tempSource';

export function openHealthHistoryDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // api-server is the only writer, but a harness (or `camctl`, one day) may
  // open the same file read-only while a tick is mid-write.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare('INSERT OR REPLACE INTO samples (metric, subject, at_ms, value) VALUES (?, ?, ?, ?)'),
    range: db.prepare(
      'SELECT at_ms, value FROM samples WHERE metric = ? AND subject = ? AND at_ms >= ? AND at_ms < ? ORDER BY at_ms',
    ),
    oldest: db.prepare('SELECT MIN(at_ms) AS oldest FROM samples'),
    // Batched, the same shape as agent/events-db.mjs's deleteEndedBefore: a
    // row value IN a LIMITed subquery, since this table's key is composite
    // (WITHOUT ROWID has no integer id to delete by).
    pruneBatch: db.prepare(
      'DELETE FROM samples WHERE (metric, subject, at_ms) IN (SELECT metric, subject, at_ms FROM samples WHERE at_ms < ? LIMIT ?)',
    ),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    // Which subjects this metric pair has ANY sample for, at or after `sinceMs`
    // -- used to answer "which interfaces have data in this range" from the
    // store itself rather than from one process's in-memory tick history,
    // which is empty right after a restart even though the DB is not.
    distinctSubjectsSince: db.prepare(
      'SELECT DISTINCT subject FROM samples WHERE metric IN (?, ?) AND at_ms >= ? ORDER BY subject',
    ),
    // The activity page's watchMeasuredFromUtc (ACTIVITY-PAGE-SPEC.md): the
    // very first instant a metric+subject was EVER written, unbounded by any
    // requested range -- a bucket from last month must still read as
    // "before the sample existed" if the feature was only turned on
    // yesterday, which a range-bounded query could never tell it.
    earliestForSubject: db.prepare('SELECT MIN(at_ms) AS m FROM samples WHERE metric = ? AND subject = ?'),
  };

  return {
    /**
     * Every row one sampler tick produced, as one transaction. Called AFTER
     * every I/O read for the tick has already finished -- the DB is never
     * held open across an await (spec: "Keep the writes small and
     * synchronous").
     */
    insertMany(rows) {
      if (rows.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const r of rows) stmts.insert.run(r.metric, r.subject, r.atMs, r.value);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    /** `[{ atMs, value }]`, ascending, for one series inside `[startMs, endMsExclusive)`. */
    rangeFor(metric, subject, startMs, endMsExclusive) {
      return stmts.range.all(metric, subject, startMs, endMsExclusive).map((r) => ({ atMs: Number(r.at_ms), value: Number(r.value) }));
    },
    /** The oldest sample kept, across every metric and subject -- null when the store is empty. */
    oldestAtMs() {
      const row = stmts.oldest.get();
      return row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest);
    },
    /** One batch of the hourly prune. Returns rows deleted; fewer than `batchSize` means this pass is done. */
    pruneOlderThan(cutoffMs, batchSize) {
      return Number(stmts.pruneBatch.run(cutoffMs, batchSize).changes);
    },
    /** Small metadata that must survive a process restart -- see META_TEMP_SOURCE. */
    setMeta(key, value) {
      stmts.setMeta.run(key, value);
    },
    /** null when never set, exactly like a samples series with no rows. */
    getMeta(key) {
      const row = stmts.getMeta.get(key);
      return row === undefined ? null : row.value;
    },
    /** `[subject, ...]`, ascending, for whichever of these two metrics has a
     *  row at or after `sinceMs` -- e.g. every interface with rx or tx data
     *  inside the requested range, read back from the store rather than from
     *  a live process's own memory. */
    distinctSubjectsSince(metricA, metricB, sinceMs) {
      return stmts.distinctSubjectsSince.all(metricA, metricB, sinceMs).map((r) => r.subject);
    },
    /** The first instant (epoch ms) this metric+subject ever has a row, or
     *  null when it never has -- see stmts.earliestForSubject's own comment. */
    earliestForSubject(metric, subject) {
      const row = stmts.earliestForSubject.get(metric, subject);
      return row?.m === null || row?.m === undefined ? null : Number(row.m);
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// NVR readers: /proc/stat, /proc/loadavg, /proc/meminfo, hwmon, thermal_zone.
// Every one takes { platform, readFileFn, readdirFn } and answers null / []
// rather than throwing -- a Windows dev box and a Linux box missing a
// particular sensor look identical to the sampler: nothing to write.
// ---------------------------------------------------------------------------

const PROC_STAT = '/proc/stat';
const PROC_LOADAVG = '/proc/loadavg';
const PROC_MEMINFO = '/proc/meminfo';
const SYS_HWMON = '/sys/class/hwmon';
const SYS_THERMAL = '/sys/class/thermal';

export async function readProcStatSample({ platform = process.platform, readFileFn = readFile } = {}) {
  if (!isLinux(platform)) return null;
  try {
    return parseProcStat(await readFileFn(PROC_STAT, 'utf8'));
  } catch {
    return null;
  }
}

export async function readLoad1({ platform = process.platform, readFileFn = readFile } = {}) {
  if (!isLinux(platform)) return null;
  try {
    return parseProcLoadavg(await readFileFn(PROC_LOADAVG, 'utf8'));
  } catch {
    return null;
  }
}

export async function readMeminfoSample({ platform = process.platform, readFileFn = readFile } = {}) {
  if (!isLinux(platform)) return null;
  try {
    return parseProcMeminfo(await readFileFn(PROC_MEMINFO, 'utf8'));
  } catch {
    return null;
  }
}

/** Every hwmon chip's tempN_label / tempN_input pair this box exposes, as
 *  contracts/healthHistory.ts's HwmonTempInput[]. tempN_input is millidegrees
 *  C, per the kernel's own hwmon ABI -- divided by 1000 here, once, so nothing
 *  downstream has to remember that unit conversion. */
export async function readHwmonInputs({ platform = process.platform, readdirFn = readdir, readFileFn = readFile } = {}) {
  if (!isLinux(platform)) return [];
  let chips;
  try {
    chips = await readdirFn(SYS_HWMON);
  } catch {
    return [];
  }
  const inputs = [];
  for (const chip of chips) {
    const dir = join(SYS_HWMON, chip);
    let chipName;
    try {
      chipName = (await readFileFn(join(dir, 'name'), 'utf8')).trim();
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await readdirFn(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = /^temp(\d+)_label$/.exec(entry);
      if (m === null) continue;
      const n = m[1];
      let label, raw;
      try {
        label = (await readFileFn(join(dir, `temp${n}_label`), 'utf8')).trim();
        raw = (await readFileFn(join(dir, `temp${n}_input`), 'utf8')).trim();
      } catch {
        continue;
      }
      const milliC = Number(raw);
      if (!Number.isFinite(milliC)) continue;
      inputs.push({ chip: chipName, label, tempC: milliC / 1000 });
    }
  }
  return inputs;
}

/** Every `thermal_zoneN` this box exposes, as ThermalZoneInput[]. Same
 *  millidegrees-C convention as hwmon. */
export async function readThermalZoneInputs({ platform = process.platform, readdirFn = readdir, readFileFn = readFile } = {}) {
  if (!isLinux(platform)) return [];
  let zones;
  try {
    zones = await readdirFn(SYS_THERMAL);
  } catch {
    return [];
  }
  const inputs = [];
  for (const zone of zones) {
    if (!zone.startsWith('thermal_zone')) continue;
    const dir = join(SYS_THERMAL, zone);
    let type, raw;
    try {
      type = (await readFileFn(join(dir, 'type'), 'utf8')).trim();
      raw = (await readFileFn(join(dir, 'temp'), 'utf8')).trim();
    } catch {
      continue;
    }
    const milliC = Number(raw);
    if (!Number.isFinite(milliC)) continue;
    inputs.push({ zone, type, tempC: milliC / 1000 });
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// detect-health.json: the detector's own health file (agent/detect-service.mjs
// writeHealth()), read the same tolerant way recorderRunning() reads
// health.json -- missing, unreadable or not shaped like JSON is "nothing to
// report", never a thrown error taking the whole tick down with it. Cross-
// platform and cross-process (a separate service writes this file, may not
// be installed at all, or may be mid-rewrite): every failure mode answers
// null, same policy as readProcStatSample and friends above.
// ---------------------------------------------------------------------------

/** How recent a detector's own last-seen instant must be to count as
 *  "watching now" -- the spec's own number (ACTIVITY-PAGE-SPEC.md). */
export const DETECTING_THRESHOLD_MS = 120_000;

async function readDetectHealth(file, readFileFn) {
  let raw;
  try {
    raw = await readFileFn(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.cameras)) return null;
  return parsed;
}

/**
 * Whether `cam` (one entry of detect-health.json's own `cameras` array) was
 * watching within `thresholdMs` of `atMs`: its `lastFrameUtc`, or its
 * `gate.lastWindow.atUtc` when the motion gate is on -- either is "the
 * detector was alive for this camera", per the spec's own words. The more
 * recent of the two wins when both are present (a gated camera's own
 * `lastFrameUtc` can lag behind its gate window, per detect-service.mjs's
 * own comment on why nothing today reads `lastFrameUtc` as a staleness
 * signal by itself).
 *
 * Always a real 0 or 1 once `cam` is a real entry -- never "unmeasured":
 * that only happens one level up, when the camera has no entry in the file
 * (or the file itself could not be read) and so no row is written at all.
 */
function detectingFromCameraHealth(cam, atMs, thresholdMs = DETECTING_THRESHOLD_MS) {
  const lastFrameMs = typeof cam?.lastFrameUtc === 'string' ? Date.parse(cam.lastFrameUtc) : NaN;
  const gateMs = typeof cam?.gate?.lastWindow?.atUtc === 'string' ? Date.parse(cam.gate.lastWindow.atUtc) : NaN;
  const candidates = [lastFrameMs, gateMs].filter((ms) => Number.isFinite(ms));
  if (candidates.length === 0) return 0;
  const mostRecentMs = Math.max(...candidates);
  // Matches recordingStateSample's own convention (contracts/healthHistory.ts):
  // no lower-bound guard against a timestamp that looks like it is in the
  // future -- two processes' clocks are assumed to agree, the same
  // assumption already made everywhere else in this file.
  return atMs - mostRecentMs <= thresholdMs ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Segments sealed inside one 60s tick's own window -- NOT cameraFacts' lifetime
// aggregate. `endMsExclusive` is the tick's own `atMs`; a segment must be
// sealed (state='sealed'), have a measured byte count, and have sealed inside
// `[startMs, endMsExclusive)` to count for THIS minute's kbps.
// ---------------------------------------------------------------------------

function sealedInWindow(index, cameraId, startMs, endMsExclusive) {
  const rows = index.db
    .prepare(
      `SELECT bytes, start_ms, end_ms FROM segments
        WHERE camera_id = ? AND state = 'sealed' AND bytes IS NOT NULL
          AND end_ms IS NOT NULL AND end_ms >= ? AND end_ms < ?`,
    )
    .all(cameraId, startMs, endMsExclusive);
  return rows.map((r) => ({
    bytes: Number(r.bytes),
    startUtc: new Date(Number(r.start_ms)).toISOString(),
    endUtc: new Date(Number(r.end_ms)).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Drive labels: the spec's own words for `subject` are "nvr, a store root's
// LABEL, a camera id or an interface name, never a path with a user in it" --
// but config.storeRoots (agent/config.mjs) carries plain filesystem paths and
// nothing else, the same as every other file that reads it (harvest.mjs,
// gate-check.mjs, recorder-service.mjs, ...). Rather than invent a new config
// field only this one feature would read, this derives a label from each
// root's own basename ("disk0" from "/srv/camplat/disk0") -- stable for as
// long as config.storeRoots itself does not change, and never a path
// component that could carry an OS username. Two roots that happen to share a
// basename (nested under different parents) get "-2", "-3", ... appended so
// the label is still unique.
export function driveLabelsFor(storeRoots) {
  const seen = new Map();
  return storeRoots.map((root) => {
    const base = basename(root) || 'drive';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

// ---------------------------------------------------------------------------
// The sampler + the GET /health/history read path. agent/api-server.mjs owns
// starting and stopping this, behind `healthHistoryEnabled`, exactly the way
// it owns agent/network-facts.mjs's startNetworkFacts.
// ---------------------------------------------------------------------------

/**
 * `deps` carries every injectable source; every field has a real production
 * default. `networkFacts` is the object agent/network-facts.mjs's
 * startNetworkFacts() returns when the Network page is ALSO enabled on this
 * server -- its `interfaceRates()` is reused so this sampler never reads
 * `/sys/class/net` a second time. Pass `null` (the default) when the Network
 * page is off; this sampler then keeps its own small counter history and
 * computes the same rates itself, via the same contracts/networkView.ts
 * `counterRate` function agent/network-facts.mjs uses.
 */
export function startHealthHistory({
  config,
  index,
  stateDir,
  now = () => new Date(),
  platform = process.platform,
  readFileFn = readFile,
  readdirFn = readdir,
  networkFacts = null,
  intervalMs = SAMPLE_INTERVAL_MS,
  pruneIntervalMs = PRUNE_INTERVAL_MS,
  pruneBatchSize = PRUNE_BATCH_SIZE,
  retentionMs = RETENTION_MS,
  recordingThresholdSeconds = RECORDING_THRESHOLD_SECONDS,
  db = openHealthHistoryDb(join(stateDir, HEALTH_HISTORY_DB_FILE)),
  log = () => {},
} = {}) {
  const healthFile = join(stateDir, 'health.json');
  const detectHealthFile = join(stateDir, 'detect-health.json');
  const cameraIds = config.cameras.map((c) => c.cameraId);
  // Computed once, from config, the same way cameraIds is above -- stable for
  // this process's lifetime and recomputed identically on every restart as
  // long as config.storeRoots itself has not changed.
  const driveLabels = driveLabelsFor(config.storeRoots);
  const driveLabelByRoot = new Map(config.storeRoots.map((root, i) => [root, driveLabels[i]]));

  // --- state carried between ticks ---
  let prevCpuStat = null; // for cpuPercent()'s own prev/next diff
  let lastTempSource = null; // set only once THIS process has itself measured a temperature this run
  let lastIfaceNames = []; // whichever interfaces THIS process has itself reported a rate for
  const ifaceCounterPrev = new Map(); // only used in the fallback path (networkFacts === null): name -> { rx, tx }
  // Both of the above are per-process memory, empty right after every
  // restart even though the DB (and the source they describe) are not --
  // readHistory() below never trusts them alone; see META_TEMP_SOURCE and
  // db.distinctSubjectsSince.

  /** This tick's { name -> { rxMbps, txMbps } }, reusing the Network page's
   *  own sampler when it is running (see the doc comment above), or reading
   *  the same /sys files itself when it is not. */
  async function ifaceRatesForTick(atUtc) {
    if (networkFacts !== null && typeof networkFacts.interfaceRates === 'function') {
      return networkFacts.interfaceRates();
    }
    const rates = new Map();
    if (!isLinux(platform)) return rates;
    const names = await listInterfaceNames({ platform, readdirFn });
    for (const name of names) {
      const sample = await readCounterSample(name, atUtc, { platform, readFileFn });
      const prev = ifaceCounterPrev.get(name) ?? { rx: null, tx: null };
      const rxResult = sample.rx !== null ? counterRate(prev.rx, sample.rx) : null;
      const txResult = sample.tx !== null ? counterRate(prev.tx, sample.tx) : null;
      rates.set(name, {
        rxMbps: rxResult !== null && rxResult.kind === 'ok' ? rxResult.mbps : null,
        txMbps: txResult !== null && txResult.kind === 'ok' ? txResult.mbps : null,
      });
      ifaceCounterPrev.set(name, {
        rx: sample.rx ?? prev.rx,
        tx: sample.tx ?? prev.tx,
      });
    }
    return rates;
  }

  /** The actual body of one 60s tick -- never called directly; always through
   *  runTick() below, which is the only thing that may start one. */
  async function runTickInner() {
    const atDate = now();
    const atMs = atDate.getTime();
    const atUtc = atDate.toISOString();
    const windowStartMs = atMs - intervalMs;
    const rows = [];

    // --- NVR: cpu, load1, memory, temperature ---
    const cpuStat = await readProcStatSample({ platform, readFileFn });
    if (cpuStat !== null) {
      const result = cpuPercent(prevCpuStat, cpuStat);
      if (result.kind === 'ok') rows.push({ metric: METRIC.CPU_PERCENT, subject: NVR_SUBJECT, atMs, value: result.percent });
      prevCpuStat = cpuStat;
    } else {
      // Nothing to read this tick (Windows, or the file vanished): the next
      // real reading starts fresh, exactly like a reboot's "no_previous".
      prevCpuStat = null;
    }

    const load1 = await readLoad1({ platform, readFileFn });
    if (load1 !== null) rows.push({ metric: METRIC.LOAD1, subject: NVR_SUBJECT, atMs, value: load1 });

    const mem = await readMeminfoSample({ platform, readFileFn });
    if (mem !== null) rows.push({ metric: METRIC.MEM_USED_MIB, subject: NVR_SUBJECT, atMs, value: mem.memUsedMiB });

    const hwmon = await readHwmonInputs({ platform, readdirFn, readFileFn });
    const thermalZones = await readThermalZoneInputs({ platform, readdirFn, readFileFn });
    const temp = chooseTempSource(hwmon, thermalZones);
    if (temp.kind === 'measured') {
      rows.push({ metric: METRIC.TEMP_C, subject: NVR_SUBJECT, atMs, value: temp.tempC });
      lastTempSource = temp.source;
      // Persisted so a request landing after a restart, before THIS process
      // has itself measured a temperature, can still report which source the
      // still-valid historical buckets came from -- see readHistory() below.
      db.setMeta(META_TEMP_SOURCE, temp.source);
    }

    // --- drives: one row per configured store root, via the same statfs
    // storeFact() already uses for /health. `subject` is the root's LABEL
    // (driveLabelByRoot), never the raw path -- see driveLabelsFor's own doc
    // comment for why.
    for (const root of config.storeRoots) {
      const fact = await storeFact(root);
      if (fact.mounted && fact.totalBytes !== null && fact.freeBytes !== null && fact.totalBytes > 0) {
        const usedBytes = fact.totalBytes - fact.freeBytes;
        rows.push({ metric: METRIC.DRIVE_USED_PCT, subject: driveLabelByRoot.get(root), atMs, value: (usedBytes / fact.totalBytes) * 100 });
      }
    }

    // --- cameras: recordedKbps (this tick's own sealed window) and recording state ---
    const facts = cameraFacts(index, cameraIds);
    for (const cameraId of cameraIds) {
      const segments = sealedInWindow(index, cameraId, windowStartMs, atMs);
      const kbpsResult = recordedKbps(segments);
      if (kbpsResult.kind === 'measured') {
        rows.push({ metric: METRIC.CAMERA_KBPS, subject: cameraId, atMs, value: kbpsResult.kbps });
      }
      const lastSealedUtc = facts.get(cameraId)?.lastSealedUtc ?? null;
      const recordingValue = recordingStateSample(lastSealedUtc, atUtc, recordingThresholdSeconds);
      // Always written -- recordingStateSample is never "unmeasured" (its own doc comment).
      rows.push({ metric: METRIC.CAMERA_RECORDING, subject: cameraId, atMs, value: recordingValue });
    }

    // --- detecting: the activity page's watched-minutes source. A row is
    // written ONLY for a camera detect-health.json itself names -- the file
    // missing, unreadable, or simply not yet mentioning this camera (the
    // detector was never installed, or has not started for it) writes
    // NOTHING for it, ever, rather than a guessed 0 (build rule 5): that
    // absence is exactly what /activity's watchMeasuredFromUtc reports as
    // "watch time not measured", and a stored 0 here would instead read as
    // "measured, and definitely not watching", which is a different claim.
    const detectHealth = await readDetectHealth(detectHealthFile, readFileFn);
    if (detectHealth !== null) {
      const byId = new Map(detectHealth.cameras.map((c) => [c.cameraId, c]));
      for (const cameraId of cameraIds) {
        const cam = byId.get(cameraId);
        if (cam === undefined) continue;
        rows.push({ metric: METRIC.CAMERA_DETECTING, subject: cameraId, atMs, value: detectingFromCameraHealth(cam, atMs) });
      }
    }

    // --- recorder alive ---
    const alive = await recorderRunning(healthFile, atMs);
    if (alive !== null) {
      rows.push({ metric: METRIC.RECORDER_RUNNING, subject: NVR_SUBJECT, atMs, value: alive ? 1 : 0 });
    }

    // --- network interfaces ---
    const rates = await ifaceRatesForTick(atUtc);
    if (rates.size > 0) lastIfaceNames = [...rates.keys()];
    for (const [name, rate] of rates) {
      if (rate.rxMbps !== null) rows.push({ metric: METRIC.IFACE_RX_MBPS, subject: name, atMs, value: rate.rxMbps });
      if (rate.txMbps !== null) rows.push({ metric: METRIC.IFACE_TX_MBPS, subject: name, atMs, value: rate.txMbps });
    }

    // One transaction, after every read above has already finished.
    db.insertMany(rows);
    return rows.length;
  }

  // THE FEARED FAILURE (build rule 19): runTickInner awaits real I/O
  // (storeFact's statfs, in particular, is a real, unbounded, non-Linux-gated
  // call) with no timeout. Nothing stopped a slow tick from still being in
  // flight when the next 60s timer fired -- two runTickInner() calls
  // interleaving on the SAME shared closure state (prevCpuStat above all:
  // cpuPercent(prevCpuStat, cpuStat) reads it again after its own await, so a
  // tick that resumes after a second tick already ran would diff against the
  // WRONG previous reading). `tickInFlight` makes runTick() itself the only
  // way to start a tick, and a call that lands while one is already running
  // shares that SAME in-flight promise instead of starting a second.
  //
  // Deliberately NOT `async function`: an async function always wraps its
  // return value in a brand-new promise, so two overlapping callers would
  // each get a different (if equivalently-resolving) object back. Returning
  // `tickInFlight` itself, from a plain function, means every caller that
  // arrives while a tick is running is handed the literal same promise.
  let tickInFlight = null;
  function runTick() {
    if (tickInFlight !== null) {
      log('info', 'health history: sampler tick still running; timer fire shared it rather than overlapping it', {});
      return tickInFlight;
    }
    tickInFlight = runTickInner().finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
  }

  const safely = (fn) => () => {
    fn().catch((err) => log('error', 'health history sampler tick failed', { error: String(err?.message ?? err) }));
  };
  const initialTick = runTick().catch((err) => {
    log('error', 'health history: first sample failed', { error: String(err?.message ?? err) });
  });
  const tickTimer = setInterval(safely(runTick), intervalMs);
  tickTimer.unref?.();

  /** One batch of the hourly prune; returns rows deleted this call. Exposed
   *  the same way runTick is, for a harness to drive deterministically. */
  async function runPrune() {
    const cutoffMs = now().getTime() - retentionMs;
    return db.pruneOlderThan(cutoffMs, pruneBatchSize);
  }
  async function runPruneToCompletion() {
    let total = 0;
    for (;;) {
      const n = await runPrune();
      total += n;
      if (n < pruneBatchSize) break;
      // db.pruneOlderThan is a synchronous node:sqlite DELETE -- awaiting its
      // own result only defers through the microtask queue, never a real
      // event-loop turn. A backlog of many batches (the process down for a
      // long stretch, a clock jump) would otherwise run every DELETE back to
      // back with nothing else, including an incoming HTTP request, getting a
      // turn until the whole catch-up finished. Yielding a real macrotask
      // between batches lets the server keep answering while it works
      // through a large backlog.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (total > 0) log('info', 'health history: pruned rows older than retention', { deleted: total, retentionDays: RETENTION_DAYS });
    return total;
  }
  runPruneToCompletion().catch((err) => log('error', 'health history: prune failed', { error: String(err?.message ?? err) }));
  const pruneTimer = setInterval(
    () => runPruneToCompletion().catch((err) => log('error', 'health history: prune failed', { error: String(err?.message ?? err) })),
    pruneIntervalMs,
  );
  pruneTimer.unref?.();

  /**
   * GET /health/history's whole body. `range` is already validated
   * (contracts/healthHistory.ts validateHistoryRange) by the caller.
   */
  function readHistory(range, nowDate) {
    const nowMs = nowDate.getTime();
    const bucketMs = BUCKET_MS[range];
    const bucketCount = BUCKET_COUNT[range];
    const rangeStartMs = nowMs - bucketMs * bucketCount;
    const rangeStartUtc = new Date(rangeStartMs).toISOString();
    const rangeEndUtc = nowDate.toISOString();

    const lineSeries = (metric, subject, unit) => {
      const samples = db
        .rangeFor(metric, subject, rangeStartMs, nowMs)
        .map((r) => ({ atUtc: new Date(r.atMs).toISOString(), value: r.value }));
      return { unit, buckets: bucketSamples(samples, rangeStartUtc, range) };
    };

    const stateSeries = (metric, subject) => {
      const samples = db
        .rangeFor(metric, subject, rangeStartMs, nowMs)
        .map((r) => ({ atUtc: new Date(r.atMs).toISOString(), state: r.value === 1 ? 'on' : 'off' }));
      return { spans: buildStateSpans(samples, rangeStartUtc, rangeEndUtc, SAMPLE_INTERVAL_MS) };
    };

    const oldestMs = db.oldestAtMs();

    return {
      ok: true,
      range,
      atUtc: rangeEndUtc,
      // The oldest sample the store holds, across every series -- an empty
      // store (feature just turned on) reads as "history from now", not a
      // fabricated earlier time.
      historyFromUtc: oldestMs === null ? rangeEndUtc : new Date(oldestMs).toISOString(),
      cpu: lineSeries(METRIC.CPU_PERCENT, NVR_SUBJECT, UNIT[METRIC.CPU_PERCENT]),
      load1: lineSeries(METRIC.LOAD1, NVR_SUBJECT, UNIT[METRIC.LOAD1]),
      memUsedMiB: lineSeries(METRIC.MEM_USED_MIB, NVR_SUBJECT, UNIT[METRIC.MEM_USED_MIB]),
      // `lastTempSource` is only ever set once THIS process has itself
      // measured a temperature -- right after a restart, before that first
      // measurement lands, it is null even though the buckets above may
      // still carry real medians queried straight from the DB. Falling back
      // to the persisted meta row (written every time any process measured a
      // temperature) keeps the label truthful across that gap instead of
      // contradicting the very buckets it is captioning.
      temperature: { ...lineSeries(METRIC.TEMP_C, NVR_SUBJECT, UNIT[METRIC.TEMP_C]), source: lastTempSource ?? db.getMeta(META_TEMP_SOURCE) },
      drives: config.storeRoots.map((root) => {
        const label = driveLabelByRoot.get(root);
        return { root: label, ...lineSeries(METRIC.DRIVE_USED_PCT, label, UNIT[METRIC.DRIVE_USED_PCT]) };
      }),
      cameras: cameraIds.map((cameraId) => ({
        cameraId,
        recordedKbps: lineSeries(METRIC.CAMERA_KBPS, cameraId, UNIT[METRIC.CAMERA_KBPS]),
        recording: stateSeries(METRIC.CAMERA_RECORDING, cameraId),
      })),
      recorderRunning: stateSeries(METRIC.RECORDER_RUNNING, NVR_SUBJECT),
      // Same restart gap as temperature.source above: `lastIfaceNames` is
      // only ever populated by a rate THIS process itself computed. Union it
      // with whatever interfaces the DB itself has a row for in the requested
      // range, so a request landing right after a restart still lists every
      // interface its own historical buckets are about to show.
      interfaces: [
        ...new Set([...db.distinctSubjectsSince(METRIC.IFACE_RX_MBPS, METRIC.IFACE_TX_MBPS, rangeStartMs), ...lastIfaceNames]),
      ]
        .sort()
        .map((name) => ({
          name,
          rxMbps: lineSeries(METRIC.IFACE_RX_MBPS, name, UNIT[METRIC.IFACE_RX_MBPS]),
          txMbps: lineSeries(METRIC.IFACE_TX_MBPS, name, UNIT[METRIC.IFACE_TX_MBPS]),
        })),
    };
  }

  async function close() {
    clearInterval(tickTimer);
    clearInterval(pruneTimer);
    // Never close the DB out from under a tick still mid-write: close() used
    // to call db.close() unconditionally, which could race an in-flight
    // runTickInner() and throw "database is not open" from its own
    // db.insertMany() -- a benign-looking but real symptom of the same
    // missing-guard failure runTick()'s tickInFlight now closes off.
    if (tickInFlight !== null) {
      await tickInFlight.catch(() => {});
    }
    db.close();
  }

  /**
   * The activity page's own read (ACTIVITY-PAGE-SPEC.md): for each of
   * `cameraIds`, how many minutes of each bucket in `edges` the `detecting`
   * sample was 1. Each camera's own bucket arithmetic is gated on THAT
   * CAMERA'S OWN earliest `detecting` sample, never a different camera's --
   * a camera added to the site later than another must still read null
   * (never a guessed 0) for the hours before ITS OWN sampling began, even
   * while a sibling camera in the same request already has months of
   * history (build rule 5: a blank is not a zero). `edges` is whatever
   * contracts/activity.ts's `hourBucketsFor24h` or one day's own `hours`
   * from `dayBucketsFor7d` produced -- this function does not care which,
   * it only reads the store between the first and last edge's own instants.
   *
   * The returned top-level `watchMeasuredFromUtc` is the site-wide MIN
   * across every camera in `cameraIds` (null when none of them has ever
   * been sampled) -- documented, site-wide metadata for the response
   * envelope, deliberately NOT what gates any one camera's own per-bucket
   * arithmetic below.
   *
   * The arithmetic itself (which samples land in which bucket, and the
   * null-before-watchMeasuredFromUtc rule) is
   * contracts/activityMeasure.ts's watchedMinutesForBuckets -- this is only
   * the I/O: reading the rows and each camera's own earliest-ever instant
   * back out of health-history.db.
   */
  function watchedMinutesFor(cameraIdsToRead, edges) {
    // Each camera's OWN earliest `detecting` sample -- never borrowed from a
    // different camera in the same request. A camera added to the site after
    // another one already had months of history must still come back null
    // for the hours before ITS OWN sampling began, even though a sibling
    // camera's sampling started earlier (build rule 5: a blank is not a
    // zero -- see the two fixed reviewer findings this guards against).
    let earliestMs = null; // the site-wide MIN, for the top-level envelope field only.
    const earliestMsByCamera = new Map();
    for (const cameraId of cameraIdsToRead) {
      const e = db.earliestForSubject(METRIC.CAMERA_DETECTING, cameraId);
      earliestMsByCamera.set(cameraId, e);
      if (e !== null && (earliestMs === null || e < earliestMs)) earliestMs = e;
    }
    const watchMeasuredFromUtc = earliestMs === null ? null : new Date(earliestMs).toISOString();

    const perCamera = new Map();
    if (edges.length > 0) {
      const rangeStartMs = Math.min(...edges.map((e) => Date.parse(e.startUtc)));
      const rangeEndMs = Math.max(...edges.map((e) => Date.parse(e.endUtc)));
      for (const cameraId of cameraIdsToRead) {
        const samples = db
          .rangeFor(METRIC.CAMERA_DETECTING, cameraId, rangeStartMs, rangeEndMs)
          .map((r) => ({ atUtc: new Date(r.atMs).toISOString(), value: r.value === 1 ? 1 : 0 }));
        const camEarliestMs = earliestMsByCamera.get(cameraId) ?? null;
        const camWatchMeasuredFromUtc = camEarliestMs === null ? null : new Date(camEarliestMs).toISOString();
        perCamera.set(cameraId, watchedMinutesForBuckets(edges, samples, camWatchMeasuredFromUtc));
      }
    } else {
      for (const cameraId of cameraIdsToRead) perCamera.set(cameraId, []);
    }

    return { watchMeasuredFromUtc, perCamera };
  }

  return { runTick, runPrune: runPruneToCompletion, readHistory, watchedMinutesFor, initialTick, close };
}
