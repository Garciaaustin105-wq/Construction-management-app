/**
 * agent/health-history.mjs: the I/O sampler, the health-history.db store, and
 * GET /health/history's wiring into agent/api-server.mjs
 * (HEALTH-HISTORY-SPEC.md). contracts/healthHistory.ts's own arithmetic
 * (cpuPercent, bucketSamples, buildStateSpans, ...) is proven by
 * harness/healthHistory.harness.mjs; this file proves the I/O and the wiring
 * around it.
 *
 * The failures feared, by name (build rule 19):
 *  - a Windows-shaped (or any non-Linux) source writing a row instead of
 *    nothing at all;
 *  - the sampler holding the DB open across an await, or losing a row when
 *    two sources race;
 *  - the route answering something other than medians/nulls/units, or a bad
 *    `range` silently defaulting instead of 400;
 *  - a role without /health's own permission reaching /health/history anyway;
 *  - the hourly prune deleting a row it should have kept, or keeping one it
 *    should have dropped;
 *  - the sampler's timers surviving close();
 *  - THE FEARED ONE: a camera's user:pass reaching the sqlite FILE's own
 *    bytes on disk, or the JSON body.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndex } from '../agent/segindex.mjs';
import { createApiServer } from '../agent/api-server.mjs';
import { decideRoute } from '../dist/routeAccess.js';
import {
  HEALTH_HISTORY_DB_FILE,
  SAMPLE_INTERVAL_MS,
  openHealthHistoryDb,
  readProcStatSample,
  readLoad1,
  readMeminfoSample,
  readHwmonInputs,
  readThermalZoneInputs,
  startHealthHistory,
  driveLabelsFor,
} from '../agent/health-history.mjs';
import { check, eq, same, close, report } from './_assert.mjs';

console.log('health history run');

const installerAuth = {
  principalOf: () => ({ kind: 'user', username: 'tech', role: 'installer' }),
  handle: async () => false,
  audit: () => {},
};

const enoent = () => Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

async function tmpDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return dir;
}

// ---------------------------------------------------------------------------
// Unit-level readers: Windows (or any non-Linux platform) never even tries.
// ---------------------------------------------------------------------------

await check('readProcStatSample / readLoad1 / readMeminfoSample: non-Linux never reads, never throws', async () => {
  let called = false;
  const readFileFn = async () => {
    called = true;
    throw new Error('should never be called on windows');
  };
  same(await readProcStatSample({ platform: 'win32', readFileFn }), null, 'cpu stat');
  same(await readLoad1({ platform: 'win32', readFileFn }), null, 'load1');
  same(await readMeminfoSample({ platform: 'win32', readFileFn }), null, 'meminfo');
  eq(called, false, 'not one of the three ever called readFileFn on windows');
});

await check('readProcStatSample: linux, a real file, parses through to cpuPercent territory', async () => {
  const readFileFn = async (p) => {
    if (p === '/proc/stat') return 'cpu  100 0 50 800 10 0 0 0\n';
    return enoent();
  };
  const sample = await readProcStatSample({ platform: 'linux', readFileFn });
  same(sample, { user: 100, nice: 0, system: 50, idle: 800, iowait: 10, irq: 0, softirq: 0, steal: 0 }, 'parsed');
});

await check('readProcStatSample: linux, file missing (ENOENT), is null -- never throws out of the sampler', async () => {
  const sample = await readProcStatSample({ platform: 'linux', readFileFn: enoent });
  same(sample, null, 'no row, not a crash');
});

await check('readHwmonInputs / readThermalZoneInputs: non-Linux answer empty, and hwmon divides millidegrees by 1000', async () => {
  eq((await readHwmonInputs({ platform: 'win32', readdirFn: async () => ['hwmon0'], readFileFn: async () => '1' })).length, 0, 'windows: nothing');
  eq((await readThermalZoneInputs({ platform: 'win32', readdirFn: async () => ['thermal_zone0'], readFileFn: async () => '1' })).length, 0, 'windows: nothing');

  const readdirFn = async (p) => (String(p).endsWith('hwmon') ? ['hwmon0'] : ['name', 'temp1_label', 'temp1_input']);
  const readFileFn = async (p) => {
    const s = String(p).replace(/\\/g, '/');
    if (s.endsWith('/name')) return 'coretemp\n';
    if (s.endsWith('temp1_label')) return 'Package id 0\n';
    if (s.endsWith('temp1_input')) return '54200\n'; // 54.2C in millidegrees
    return enoent();
  };
  const inputs = await readHwmonInputs({ platform: 'linux', readdirFn, readFileFn });
  same(inputs, [{ chip: 'coretemp', label: 'Package id 0', tempC: 54.2 }], 'millidegrees -> degrees, once');
});

// ---------------------------------------------------------------------------
// The store: WITHOUT ROWID, insertMany is one transaction, rangeFor and the
// batched prune.
// ---------------------------------------------------------------------------

await check('openHealthHistoryDb: insertMany then rangeFor round-trips, ordered by time', async () => {
  const dir = await tmpDir('camplat-hh-store-');
  try {
    const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
    db.insertMany([
      { metric: 'cpuPercent', subject: 'nvr', atMs: 3000, value: 30 },
      { metric: 'cpuPercent', subject: 'nvr', atMs: 1000, value: 10 },
      { metric: 'cpuPercent', subject: 'nvr', atMs: 2000, value: 20 },
      { metric: 'load1', subject: 'nvr', atMs: 1000, value: 0.5 }, // a different metric must not leak into the range below
    ]);
    const rows = db.rangeFor('cpuPercent', 'nvr', 0, 4000);
    same(rows, [{ atMs: 1000, value: 10 }, { atMs: 2000, value: 20 }, { atMs: 3000, value: 30 }], 'ascending, this metric+subject only');
    eq(db.oldestAtMs(), 1000, 'oldest across every metric');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('REQUIRED: the prune deletes only rows older than the cutoff, in batches', async () => {
  const dir = await tmpDir('camplat-hh-prune-');
  try {
    const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
    const rows = [];
    for (let i = 0; i < 25; i++) rows.push({ metric: 'cpuPercent', subject: 'nvr', atMs: i * 1000, value: i });
    db.insertMany(rows);
    const cutoffMs = 10_000; // rows 0..9 are older than this; 10..24 are kept
    let deleted = 0;
    for (;;) {
      const n = db.pruneOlderThan(cutoffMs, 4); // small batch on purpose, so this loop actually iterates
      deleted += n;
      if (n < 4) break;
    }
    eq(deleted, 10, 'exactly the rows strictly before the cutoff');
    const remaining = db.rangeFor('cpuPercent', 'nvr', 0, 25_000);
    eq(remaining.length, 15, 'the rest survive');
    eq(remaining.every((r) => r.atMs >= cutoffMs), true, 'nothing kept is older than the cutoff');
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The sampler, end to end, against fakes -- no real /proc, /sys or socket.
// ---------------------------------------------------------------------------

function makeConfig(stateDir, cameraIds = ['cam-1']) {
  return {
    siteId: 'test-site',
    storeRoots: [join(stateDir, 'disk0')],
    segmentSeconds: 60,
    credentials: { username: 'x', password: 'y' },
    cameras: cameraIds.map((cameraId) => ({ cameraId, name: cameraId, url: `rtsp://svc:hunter2@10.0.0.5/${cameraId}` })),
  };
}

function linuxFakes({ cpuUser = 1000, cpuIdle = 8000, load1 = '0.42', memTotalKb = 8_000_000, memAvailKb = 4_000_000 } = {}) {
  return {
    platform: 'linux',
    readFileFn: async (p) => {
      const s = String(p).replace(/\\/g, '/');
      if (s === '/proc/stat') return `cpu  ${cpuUser} 0 0 ${cpuIdle} 0 0 0 0\n`;
      if (s === '/proc/loadavg') return `${load1} 0.40 0.38 1/200 999\n`;
      if (s === '/proc/meminfo') return `MemTotal:       ${memTotalKb} kB\nMemAvailable:   ${memAvailKb} kB\n`;
      return enoent();
    },
    readdirFn: async () => [], // no hwmon, no thermal_zone, no /sys/class/net: keeps this fake minimal
  };
}

await check('runTick: a Linux tick with two /proc/stat readings writes cpu/load1/mem, and the first tick alone writes no cpuPercent', async () => {
  const dir = await tmpDir('camplat-hh-tick-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, []); // no cameras: isolates the NVR-only series
  let clockMs = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(clockMs);
  // Jiffies actually advance between calls, the way a real /proc/stat would --
  // a static fixture would look exactly like the "counter reset" case below.
  let cpuIdle = 8_000_000;
  const readFileFn = async (p) => {
    const s = String(p).replace(/\\/g, '/');
    if (s === '/proc/stat') { cpuIdle += 900; return `cpu  1000 0 100 ${cpuIdle} 0 0 0 0\n`; }
    if (s === '/proc/loadavg') return '0.42 0.40 0.38 1/200 999\n';
    if (s === '/proc/meminfo') return 'MemTotal:       8000000 kB\nMemAvailable:   4000000 kB\n';
    return enoent();
  };
  const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'linux', readFileFn, readdirFn: async () => [] });
  await hh.initialTick;

  const dbDirect = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  eq(dbDirect.rangeFor('cpuPercent', 'nvr', 0, clockMs + 1).length, 0, 'REQUIRED: no previous reading yet -- no cpuPercent row on tick 1');
  eq(dbDirect.rangeFor('load1', 'nvr', 0, clockMs + 1).length, 1, 'load1 needs no previous reading');
  eq(dbDirect.rangeFor('memUsedMiB', 'nvr', 0, clockMs + 1).length, 1, 'mem likewise');
  dbDirect.close();

  clockMs += SAMPLE_INTERVAL_MS;
  await hh.runTick();
  const dbAfter = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  const cpuRows = dbAfter.rangeFor('cpuPercent', 'nvr', 0, clockMs + 1);
  eq(cpuRows.length, 1, 'tick 2 has a previous reading -- one cpuPercent row');
  eq(cpuRows[0].value >= 0 && cpuRows[0].value <= 100, true, 'clamped to a plausible percent');
  dbAfter.close();

  hh.close();
  index.close();
});

await check('REQUIRED: a counter reset (reboot) between two ticks writes no cpuPercent row for that minute', async () => {
  const dir = await tmpDir('camplat-hh-reset-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, []);
  let clockMs = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(clockMs);
  const hh = startHealthHistory({ config, index, stateDir: dir, now, ...linuxFakes({ cpuUser: 5_000_000, cpuIdle: 40_000_000 }) });
  await hh.initialTick;

  clockMs += SAMPLE_INTERVAL_MS;
  // The "reboot": jiffy counters fall back to a small number.
  const rebooted = { platform: 'linux', readFileFn: async (p) => {
    const s = String(p).replace(/\\/g, '/');
    if (s === '/proc/stat') return 'cpu  10 0 0 50 0 0 0 0\n';
    return enoent();
  }, readdirFn: async () => [] };
  const hh2 = startHealthHistory({ config, index, stateDir: dir, now, db: openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE)), ...rebooted });
  hh.close(); // stop hh's own timers without closing the db a second time
  await hh2.initialTick;

  const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  const cpuRows = db.rangeFor('cpuPercent', 'nvr', 0, clockMs + 1);
  eq(cpuRows.length, 0, 'the reset tick wrote nothing, not a negative or huge percent');
  db.close();
  hh2.close();
  index.close();
});

await check('REQUIRED: a store root that is not a real mount point (a plain directory) writes no drive-usage row -- blank, not a zero', async () => {
  // The same fact agent/healthfacts.mjs's storeFact() reports to /health for
  // an identical fixture (harness/apiServer.harness.mjs: "a plain directory
  // is not the disk we were promised", state "unmounted"): a tmp-dir store
  // root shares its parent's device, so it reads as unmounted however much
  // free space statfs claims -- and this sampler must not turn that into a
  // usedPct row that looks like a real, if boring, measurement.
  const dir = await tmpDir('camplat-hh-drive-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, []);
  const now = () => new Date('2026-09-24T12:00:00.000Z');
  const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'win32', readFileFn: enoent, readdirFn: async () => [] });
  await hh.initialTick;
  const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  const rows = db.rangeFor('driveUsedPct', join(dir, 'disk0'), 0, Date.now() + 1);
  eq(rows.length, 0, 'no row for an unmounted root, even though statfs itself succeeds and returns real numbers');
  db.close();
  hh.close();
  index.close();
});

await check('runTick: a camera with a sealed segment inside the window gets recordedKbps; outside it, none', async () => {
  const dir = await tmpDir('camplat-hh-cam-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, ['cam-1']);
  const atMs = Date.parse('2026-09-24T12:01:00.000Z');
  const now = () => new Date(atMs);
  // Sealed 30s before this tick (inside the 60s window) -- 1,000,000 bytes over 10s.
  index.put({
    cameraId: 'cam-1',
    startUtc: new Date(atMs - 40_000).toISOString(),
    endUtc: new Date(atMs - 30_000).toISOString(),
    path: 'disk0/cam-1/seg.mp4', bytes: 1_000_000, state: 'sealed', hold: false, pendingUpload: false, bitrateKbps: null, root: join(dir, 'disk0'),
  });
  // Sealed well before the window -- must not count.
  index.put({
    cameraId: 'cam-1',
    startUtc: new Date(atMs - 200_000).toISOString(),
    endUtc: new Date(atMs - 190_000).toISOString(),
    path: 'disk0/cam-1/old.mp4', bytes: 9_000_000, state: 'sealed', hold: false, pendingUpload: false, bitrateKbps: null, root: join(dir, 'disk0'),
  });
  const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'win32', readFileFn: enoent, readdirFn: async () => [] });
  await hh.initialTick;
  const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  const kbpsRows = db.rangeFor('recordedKbps', 'cam-1', 0, atMs + 1);
  eq(kbpsRows.length, 1, 'only the in-window segment counted');
  close(kbpsRows[0].value, (1_000_000 * 8) / 10 / 1000, 0.001, 'kbps from bytes/duration, not the older segment');

  const recRows = db.rangeFor('recording', 'cam-1', 0, atMs + 1);
  eq(recRows.length, 1, 'recording state is ALWAYS written, unlike recordedKbps');
  eq(recRows[0].value, 1, 'sealed 30s ago is within the 120s recording threshold');

  db.close();
  hh.close();
  index.close();
});

await check('REQUIRED, THE FEARED ONE: a camera configured with user:pass never reaches the sqlite FILE bytes or the JSON', async () => {
  const dir = await tmpDir('camplat-hh-secret-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, ['cam-1']); // url carries svc:hunter2
  const atMs = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(atMs);
  const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'win32', readFileFn: enoent, readdirFn: async () => [] });
  await hh.initialTick;
  await hh.runTick();
  const envelope = hh.readHistory('24h', now());
  hh.close();
  index.close();

  const dbBytes = readFileSync(join(dir, HEALTH_HISTORY_DB_FILE), 'latin1'); // latin1: read every byte, never fail on invalid utf8
  const jsonText = JSON.stringify(envelope);
  for (const secret of ['hunter2', 'svc:hunter2', 'rtsp://']) {
    eq(dbBytes.includes(secret), false, `${secret} must never appear in health-history.db's own bytes`);
    eq(jsonText.includes(secret), false, `${secret} must never appear in the /health/history JSON`);
  }
  eq(jsonText.includes('cam-1'), true, 'the bare camera id is still there -- only the credential is withheld');
});

await check('runTick: recorder-alive writes 1/0 from health.json freshness, and nothing at all when the file cannot be understood', async () => {
  const dir = await tmpDir('camplat-hh-recorder-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, []);
  const atMs = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(atMs);

  await writeFile(join(dir, 'health.json'), JSON.stringify({ atUtc: new Date(atMs - 5_000).toISOString() }));
  const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'win32', readFileFn: enoent, readdirFn: async () => [] });
  await hh.initialTick;
  hh.close();
  const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  eq(db.rangeFor('recorderRunning', 'nvr', 0, atMs + 1), [{ atMs, value: 1 }], 'written recently -- alive');
  db.close();
  index.close();
});

// ---------------------------------------------------------------------------
// The store roots' subject and every other subject: a spot check that the
// pieces above compose into a route response with medians, nulls and units.
// ---------------------------------------------------------------------------

await check('readHistory: buckets have medians and units, an empty series is all-null buckets, and a bad range is the caller\'s job to catch first', async () => {
  const dir = await tmpDir('camplat-hh-read-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, ['cam-1']);
  const atMs = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(atMs);
  const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  // Three cpuPercent samples inside the same 5-minute bucket -- median, not mean.
  db.insertMany([
    { metric: 'cpuPercent', subject: 'nvr', atMs: atMs - 60_000, value: 10 },
    { metric: 'cpuPercent', subject: 'nvr', atMs: atMs - 120_000, value: 90 },
    { metric: 'cpuPercent', subject: 'nvr', atMs: atMs - 180_000, value: 20 },
  ]);
  const hh = startHealthHistory({ config, index, stateDir: dir, now, db, platform: 'win32', readFileFn: enoent, readdirFn: async () => [] });
  const envelope = hh.readHistory('24h', now());

  eq(envelope.ok, true, 'ok');
  eq(envelope.cpu.unit, '%', 'unit is on the series');
  const lastBucket = envelope.cpu.buckets[envelope.cpu.buckets.length - 1];
  eq(lastBucket.median, 20, 'median of [10,20,90] is 20, not the mean (40)');
  eq(lastBucket.n, 3, 'n is the sample count');
  eq(envelope.cpu.buckets.some((b) => b.median === null), true, 'REQUIRED: buckets with nothing in them are null, not 0');
  eq(envelope.load1.buckets.every((b) => b.median === null), true, 'no load1 rows were ever written -- every bucket is a break, not a fabricated flat line');
  eq(envelope.cameras.length, 1, 'one configured camera');
  eq(envelope.cameras[0].cameraId, 'cam-1', 'by id, never a url');
  eq(envelope.temperature.source, null, 'no temperature ever measured -- no source label either');
  eq(envelope.historyFromUtc, new Date(atMs - 180_000).toISOString(), 'the oldest sample kept, across every series');

  hh.close();
  index.close();
});

// ---------------------------------------------------------------------------
// Adversarial-review findings (2026-09-25): a restart racing readHistory(),
// an overlapping tick, a blocking prune, and a store-root path in `subject`.
// ---------------------------------------------------------------------------

await check(
  'REQUIRED: temperature.source and interfaces answer from the DB, not only from this process\'s own possibly-still-empty memory -- "right after a restart, before the new process\'s first tick"',
  async () => {
    const dir = await tmpDir('camplat-hh-restart-');
    await mkdir(join(dir, 'disk0'), { recursive: true });
    const index = openIndex(join(dir, 'index.db'));
    const config = makeConfig(dir, []);
    const atMs = Date.parse('2026-09-24T12:00:00.000Z');
    const now = () => new Date(atMs);

    const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
    // Written by a PREVIOUS process's own tick, before "the restart" below.
    db.setMeta('tempSource', 'hwmon coretemp Package id 0');
    db.insertMany([
      { metric: 'tempC', subject: 'nvr', atMs: atMs - 60_000, value: 54.2 },
      { metric: 'rxMbps', subject: 'eth0', atMs: atMs - 60_000, value: 12.5 },
      { metric: 'txMbps', subject: 'eth0', atMs: atMs - 60_000, value: 3.1 },
    ]);

    // A brand-new startHealthHistory() over that SAME db: its own
    // lastTempSource/lastIfaceNames are exactly what fresh construction
    // leaves them (null / []), because this platform measures nothing
    // itself -- exactly what a request landing before the new process's own
    // first tick actually sees.
    const hh = startHealthHistory({
      config, index, stateDir: dir, now, db,
      platform: 'win32', readFileFn: enoent, readdirFn: async () => [],
      intervalMs: 999999, pruneIntervalMs: 999999,
    });
    const envelope = hh.readHistory('24h', now());

    eq(
      envelope.temperature.source, 'hwmon coretemp Package id 0',
      'REQUIRED: the source label survives a restart, from the persisted meta row -- not null just because this process has not measured one itself yet',
    );
    eq(
      envelope.temperature.buckets.some((b) => b.median !== null), true,
      'the buckets are real, pre-restart data -- the source label above must never contradict them by claiming "not measured"',
    );
    eq(
      envelope.interfaces.map((i) => i.name), ['eth0'],
      'REQUIRED: an interface with rows already in the DB is listed even though this process itself never sampled it',
    );

    await hh.close();
    index.close();
  },
);

await check(
  'REQUIRED, THE FEARED ONE: an overlapping tick timer fire shares the in-flight tick instead of corrupting shared cpu-baseline state',
  async () => {
    const dir = await tmpDir('camplat-hh-overlap-');
    await mkdir(join(dir, 'disk0'), { recursive: true });
    const index = openIndex(join(dir, 'index.db'));
    const config = makeConfig(dir, []);
    // Advanced by hand between ticks -- a fixed clock would give every tick
    // the SAME at_ms, and insertMany's INSERT OR REPLACE would then collapse
    // tick A's row and the real tick B's row into one, masking the very
    // corruption this test exists to catch.
    let clockMs = Date.parse('2026-09-24T12:00:00.000Z');
    const now = () => new Date(clockMs);
    const mkLine = (idle, busy) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0\n`;
    const P = mkLine(100000, 20000); // the baseline reading (initialTick)
    const statA = mkLine(100900, 20100); // tick A's true "next" (+900 idle, +100 busy)
    const statB = mkLine(101800, 20200); // tick B's true "next" -- further ahead than A

    let call = 0;
    let resolveA;
    const aGate = new Promise((resolve) => { resolveA = resolve; });
    const hh = startHealthHistory({
      config, index, stateDir: dir, now, platform: 'linux',
      readFileFn: async (p) => {
        if (String(p) !== '/proc/stat') return enoent();
        call++;
        if (call === 1) return P; // initialTick's own baseline
        if (call === 2) { await aGate; return statA; } // tick A: stalls past tick B's own timer fire
        return statB; // tick B: resolves immediately, while A is still stuck
      },
      readdirFn: async () => [],
      intervalMs: 999999, pruneIntervalMs: 999999, // never fire on their own; ticks driven by hand
    });
    await hh.initialTick; // consumes call #1 (P) at clockMs (t0)

    clockMs += 60_000; // t0 + 60s: tick A's own instant
    const tickA = hh.runTick(); // call #2, stalls on aGate
    const tickBShared = hh.runTick(); // the "timer fires again" call, while A is still running
    eq(call, 2, 'REQUIRED: the guard shared the in-flight tick -- it did not start a second, concurrent /proc/stat read while tick A was still stuck');
    eq(tickA === tickBShared, true, 'REQUIRED: a tick requested while one is already running is handed the literal SAME promise back, never a second independent one');
    resolveA();
    await tickA;

    // Now that A is done, a REAL separate tick (the timer firing later, once
    // the previous one actually finished) must still run for real -- at its
    // OWN instant, t0 + 120s, so it gets its own row rather than colliding
    // with tick A's on the (metric, subject, at_ms) primary key.
    clockMs += 60_000;
    await hh.runTick();
    eq(call, 3, 'a tick started after the previous one finished is a genuine, separate tick');

    const dbDirect = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
    const rows = dbDirect.rangeFor('cpuPercent', 'nvr', 0, Date.now() + 1);
    dbDirect.close();
    eq(rows.length, 2, 'REQUIRED: two real ticks after the baseline -- neither dropped nor corrupted by the overlap');
    eq(rows.every((r) => r.value >= 0 && r.value <= 100), true, 'every value still a plausible percent, not a negative from a mismatched baseline');

    await hh.close();
    index.close();
  },
);

await check(
  'REQUIRED: runPruneToCompletion yields the event loop between batches, so a large backlog does not stall other work',
  async () => {
    const dir = await tmpDir('camplat-hh-pruneyield-');
    await mkdir(join(dir, 'disk0'), { recursive: true });
    const index = openIndex(join(dir, 'index.db'));
    const config = makeConfig(dir, []);
    const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
    const batchSize = 10;
    const backlogRows = batchSize * 3; // three batches' worth

    // startHealthHistory() ALWAYS fires its own startup prune pass in the
    // background (unconditionally, uncontrolled by this test) -- constructed
    // here, over the still-EMPTY db, so that automatic pass finds nothing and
    // finishes at once, rather than racing the explicit hh.runPrune() call
    // below over the SAME backlog and making this test's own count wrong
    // regardless of whether the fix under test works.
    const hh = startHealthHistory({
      config, index, stateDir: dir, now: () => new Date('2100-01-01T00:00:00.000Z'), db,
      platform: 'win32', readFileFn: enoent, readdirFn: async () => [],
      intervalMs: 999999, pruneIntervalMs: 999999, pruneBatchSize: batchSize, retentionMs: 1,
    });
    await hh.initialTick;
    // Let that startup prune pass (trivial on an empty db, but still async)
    // fully settle before this test plants its own backlog.
    await new Promise((resolve) => setImmediate(resolve));

    // All older than the retention cutoff above (retentionMs: 1, against a
    // year-2100 clock).
    const rows = [];
    for (let i = 0; i < backlogRows; i++) rows.push({ metric: 'cpuPercent', subject: 'nvr-' + i, atMs: 1, value: 1 });
    db.insertMany(rows);

    let immediateFired = false;
    setImmediate(() => { immediateFired = true; });

    const deleted = await hh.runPrune();

    eq(deleted, backlogRows, 'the whole backlog was pruned, across several batches');
    eq(immediateFired, true, 'REQUIRED: a macrotask queued before the prune ran DURING it -- the loop yielded the event loop between batches, it did not block it start to finish');

    await hh.close();
    index.close();
  },
);

await check('driveLabelsFor: the basename of each root, disambiguated with -2/-3 when two roots share one', () => {
  same(driveLabelsFor(['/srv/camplat/disk0', '/srv/camplat/disk1']), ['disk0', 'disk1'], 'the ordinary case');
  same(driveLabelsFor(['/mnt/a/disk0', '/mnt/b/disk0']), ['disk0', 'disk0-2'], 'a repeated basename is disambiguated, never silently collapsed to one label');
  same(driveLabelsFor(['C:\\Users\\austin-garcia\\nvr-storage\\disk0']), ['disk0'], 'a path with a user in it becomes just the label -- the username is gone');
});

await check(
  'REQUIRED: a drive\'s subject/root is a LABEL (the root\'s own basename), never the raw configured path -- a path can carry an OS username, a label never does',
  async () => {
    const dir = await tmpDir('camplat-hh-drivelabel-');
    // A store root shaped like a real home-NVR config: a path that carries an
    // OS username, exactly the shape the spec's own words name by exception
    // ("never a path with a user in it").
    const storeRoot = join(dir, 'Users', 'austin-garcia', 'nvr-storage', 'disk0');
    await mkdir(storeRoot, { recursive: true });
    const index = openIndex(join(dir, 'index.db'));
    const config = { ...makeConfig(dir, []), storeRoots: [storeRoot] };
    const now = () => new Date('2026-09-24T12:00:00.000Z');
    const hh = startHealthHistory({
      config, index, stateDir: dir, now, platform: 'win32',
      readFileFn: enoent, readdirFn: async () => [],
      intervalMs: 999999, pruneIntervalMs: 999999,
    });
    await hh.initialTick;
    const envelope = hh.readHistory('24h', now());

    eq(envelope.drives.length, 1, 'one configured drive');
    eq(envelope.drives[0].root, 'disk0', 'REQUIRED: the label is the root\'s own basename, not the full path');
    eq(envelope.drives[0].root.includes('austin-garcia'), false, 'REQUIRED: the OS username never reaches the JSON');

    const dbBytes = readFileSync(join(dir, HEALTH_HISTORY_DB_FILE), 'latin1');
    eq(dbBytes.includes('austin-garcia'), false, 'REQUIRED: the OS username never reaches health-history.db\'s own bytes either');

    await hh.close();
    index.close();
  },
);

// ---------------------------------------------------------------------------
// End to end through the real server: enabled/disabled, permissions, 400/501.
// ---------------------------------------------------------------------------

const apiDir = await tmpDir('camplat-hh-api-');
await mkdir(join(apiDir, 'disk0'), { recursive: true });
const apiIndex = openIndex(join(apiDir, 'index.db'));
const apiConfig = makeConfig(apiDir, ['cam-1']);
let apiClockMs = Date.parse('2026-09-24T12:00:00.000Z');
const apiNow = () => new Date(apiClockMs);

const server = createApiServer({
  stateDir: apiDir,
  config: apiConfig,
  index: apiIndex,
  now: apiNow,
  auth: installerAuth,
  healthHistoryEnabled: true,
  healthHistoryOverrides: { platform: 'win32', readFileFn: enoent, readdirFn: async () => [] },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const fetchJson = async (url) => {
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
};

await check('GET /health/history?range=24h: 200, an envelope with a temperature block and per-camera series', async () => {
  const { res, json } = await fetchJson(`${base}/health/history?range=24h`);
  eq(res.status, 200, 'status');
  eq(json.ok, true, 'ok');
  eq(json.range, '24h', 'echoes the requested range');
  eq(Array.isArray(json.cameras), true, 'cameras array');
  eq(typeof json.temperature.unit, 'string', 'temperature carries a unit even when unmeasured');
});

await check('REQUIRED: an invalid ?range= is 400, never silently coerced to 24h or 7d', async () => {
  const { res, json } = await fetchJson(`${base}/health/history?range=1d`);
  eq(res.status, 400, 'status');
  eq(json.code, 'bad_range', 'code');
  const missing = await fetchJson(`${base}/health/history`);
  eq(missing.res.status, 400, 'missing range is also 400, not a default');
});

await check('the store role and a display credential get 403 on /health/history, exactly like /health; installer is allowed', () => {
  const installer = { kind: 'user', username: 'tech', role: 'installer' };
  const store = { kind: 'user', username: 'clerk', role: 'store' };
  const display = { kind: 'display', displayId: 'wall-1' };
  eq(decideRoute(installer, 'GET', '/health/history').kind, 'allow', 'installer');
  eq(decideRoute(store, 'GET', '/health/history').kind, 'allow', 'store has the same live.view reach as /health');
  eq(decideRoute(display, 'GET', '/health/history').kind, 'allow', 'so does a wall display');
  eq(decideRoute(installer, 'GET', '/health/history').kind, decideRoute(installer, 'GET', '/health').kind, 'same policy as /health for every role');
});

await check('close: server.closeHealthHistory() exists and does not throw', () => {
  server.closeHealthHistory();
});
server.close();
apiIndex.close();

await check('REQUIRED: /health/history answers 501 when the feature is disabled, like /network', async () => {
  const dir2 = await tmpDir('camplat-hh-disabled-');
  await mkdir(join(dir2, 'disk0'), { recursive: true });
  const index2 = openIndex(join(dir2, 'index.db'));
  const config2 = makeConfig(dir2, []);
  const server2 = createApiServer({ stateDir: dir2, config: config2, index: index2, auth: installerAuth });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  const { res, json } = await fetchJson(`${base2}/health/history?range=24h`);
  eq(res.status, 501, 'status');
  eq(json.code, 'health_history_disabled', 'code');
  server2.close();
  index2.close();
  await rm(dir2, { recursive: true, force: true });
});

// A second, tiny-interval server just to prove the sampler and prune timers
// actually stop on close() -- the real intervals (60s / 1h) are far too long
// to observe within a harness's bounded run time.
await check('REQUIRED, THE FEARED ONE: the sampler and prune timers keep ticking until close(), then stop for good', async () => {
  const dir3 = await tmpDir('camplat-hh-stop-');
  await mkdir(join(dir3, 'disk0'), { recursive: true });
  const index3 = openIndex(join(dir3, 'index.db'));
  const config3 = makeConfig(dir3, []);
  let ticks = 0;
  const server3 = createApiServer({
    stateDir: dir3, config: config3, index: index3, auth: installerAuth,
    healthHistoryEnabled: true,
    healthHistoryOverrides: {
      // /proc/loadavg is read, unconditionally, every single tick (unlike
      // cpuPercent, which skips writing on its own first tick) -- counting
      // calls to it is a direct count of ticks that actually ran.
      platform: 'linux',
      readFileFn: async (p) => {
        if (String(p) === '/proc/loadavg') { ticks++; return '0.1 0.1 0.1 1/1 1\n'; }
        return enoent();
      },
      readdirFn: async () => [],
      intervalMs: 20, pruneIntervalMs: 100_000,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 90)); // several 20ms ticks
  const beforeClose = ticks;
  eq(beforeClose > 1, true, 'the sampler actually ticked more than once before close()');
  server3.closeHealthHistory();
  await new Promise((resolve) => setTimeout(resolve, 90));
  eq(ticks, beforeClose, 'no tick landed after close()');
  server3.close();
  index3.close();
  await rm(dir3, { recursive: true, force: true });
});

report('health history run');
