/**
 * GET /activity, end to end (ACTIVITY-PAGE-SPEC.md, Shape item 2):
 * agent/events-db.mjs's eventsInWindow/oldestFirstMs, footage from the
 * segment index, the health-history store's new `detecting` sample and its
 * watchedMinutesFor read, agent/activity-run.mjs's own combining across
 * cameras, and the route's wiring into agent/api-server.mjs. Every pure
 * calculation this exercises (bucket edges, status, the busiest hour) is
 * already proven standalone by harness/activity.harness.mjs and
 * harness/activityMeasure.harness.mjs; this file proves the I/O around it and
 * that the pieces are wired to the right camera and the right window.
 *
 * THE FEARED FAILURES, by name (build rule 19):
 *  - counts, footage or watch minutes read from a WIDER window than the
 *    buckets need, leaking a neighbour's data into an edge bucket;
 *  - a hidden (known-object) event landing in `person`/`vehicle` instead of
 *    `hidden`;
 *  - "not watching" (a real, measured 0) and "not yet measured" (null)
 *    collapsing into the same number on the wire;
 *  - a role without events.view reaching the route anyway, or the store
 *    role/display credential getting the wrong side of that line;
 *  - a `detecting` row written when detect-health.json cannot be trusted at
 *    all -- missing, unreadable, or simply not shaped like the file
 *    agent/detect-service.mjs writes.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndex } from '../agent/segindex.mjs';
import { openEventsDb } from '../agent/events-db.mjs';
import { createApiServer } from '../agent/api-server.mjs';
import { openHealthHistoryDb, HEALTH_HISTORY_DB_FILE, startHealthHistory, DETECTING_THRESHOLD_MS } from '../agent/health-history.mjs';
import { combineHourBuckets, buildActivityResponse } from '../agent/activity-run.mjs';
import { decideRoute } from '../dist/routeAccess.js';
import { check, mustAwait, eq, same, close, report } from './_assert.mjs';

console.log('activity run');

const enoent = () => Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

async function tmpDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

function makeConfig(stateDir, cameraIds) {
  return {
    siteId: 'test-site',
    storeRoots: [join(stateDir, 'disk0')],
    segmentSeconds: 60,
    credentials: { username: 'x', password: 'y' },
    cameras: cameraIds.map((cameraId) => ({ cameraId, name: cameraId, url: `rtsp://svc:hunter2@10.0.0.5/${cameraId}` })),
  };
}

const installerAuth = {
  principalOf: () => ({ kind: 'user', username: 'tech', role: 'installer' }),
  handle: async () => false,
  audit: () => {},
};
const authAs = (principal) => ({ principalOf: () => principal, handle: async () => false, audit: () => {} });

function ev(id, kind, firstUtc, cameraId, opts = {}) {
  return {
    id,
    event: {
      cameraId,
      kind,
      firstUtc,
      lastUtc: firstUtc,
      count: 1,
      bestConfidence: 0.9,
      bestUtc: firstUtc,
    },
    opts,
  };
}

function putEvents(file, events) {
  const db = openEventsDb(file);
  for (const e of events) db.upsert({ id: e.id, event: e.event }, true, e.opts);
  db.close();
}

function putDetectingSamples(file, subject, rows) {
  const db = openHealthHistoryDb(file);
  db.insertMany(rows.map((r) => ({ metric: 'detecting', subject, atMs: r.atMs, value: r.value })));
  db.close();
}

// ---------------------------------------------------------------------------
// events-db.mjs: eventsInWindow / oldestFirstMs, against a real (in-memory)
// database.
// ---------------------------------------------------------------------------

check('eventsInWindow: only cameraId/kind/firstMs/suppressedBy, half-open on [start,end), ordered by first_ms', () => {
  const db = openEventsDb(':memory:');
  db.upsert({ id: 'a', event: { cameraId: 'cam-1', kind: 'person', firstUtc: '2026-09-24T12:00:00.000Z', lastUtc: '2026-09-24T12:00:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-24T12:00:00.000Z' } }, true);
  db.upsert({ id: 'b', event: { cameraId: 'cam-1', kind: 'vehicle', firstUtc: '2026-09-24T13:00:00.000Z', lastUtc: '2026-09-24T13:00:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-24T13:00:00.000Z' } }, true, { suppressedBy: 'obj-1' });
  db.upsert({ id: 'c-other-camera', event: { cameraId: 'cam-2', kind: 'person', firstUtc: '2026-09-24T12:30:00.000Z', lastUtc: '2026-09-24T12:30:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-24T12:30:00.000Z' } }, true);
  db.upsert({ id: 'd-outside', event: { cameraId: 'cam-1', kind: 'person', firstUtc: '2026-09-24T14:00:00.000Z', lastUtc: '2026-09-24T14:00:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-24T14:00:00.000Z' } }, true);
  // Still open (never finished) but its first_ms is in the window -- must
  // still be counted; the activity page buckets by when a sighting STARTED.
  db.upsert({ id: 'e-unfinished', event: { cameraId: 'cam-1', kind: 'vehicle', firstUtc: '2026-09-24T12:45:00.000Z', lastUtc: '2026-09-24T12:45:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-24T12:45:00.000Z' } }, false);

  const found = db.eventsInWindow(['cam-1'], '2026-09-24T12:00:00.000Z', '2026-09-24T14:00:00.000Z');
  same(
    found,
    [
      { cameraId: 'cam-1', kind: 'person', firstMs: Date.parse('2026-09-24T12:00:00.000Z'), suppressedBy: null },
      { cameraId: 'cam-1', kind: 'vehicle', firstMs: Date.parse('2026-09-24T12:45:00.000Z'), suppressedBy: null },
      { cameraId: 'cam-1', kind: 'vehicle', firstMs: Date.parse('2026-09-24T13:00:00.000Z'), suppressedBy: 'obj-1' },
    ],
    'REQUIRED: cam-2 excluded, the 14:00 event excluded (window end is exclusive), the unfinished one included, suppressedBy carried through',
  );
  db.close();
});

check('eventsInWindow: an empty camera list answers [] rather than a SQL-invalid IN ()', () => {
  const db = openEventsDb(':memory:');
  same(db.eventsInWindow([], '2026-09-24T00:00:00.000Z', '2026-09-25T00:00:00.000Z'), [], 'no cameras, no rows, no crash');
  db.close();
});

check('oldestFirstMs: the earliest first_ms for these cameras, null when they have none', () => {
  const db = openEventsDb(':memory:');
  eq(db.oldestFirstMs(['cam-1']), null, 'REQUIRED: no events at all is null, not 0 and not now');
  db.upsert({ id: 'a', event: { cameraId: 'cam-1', kind: 'person', firstUtc: '2026-09-20T00:00:00.000Z', lastUtc: '2026-09-20T00:00:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-20T00:00:00.000Z' } }, true);
  db.upsert({ id: 'b', event: { cameraId: 'cam-1', kind: 'person', firstUtc: '2026-09-22T00:00:00.000Z', lastUtc: '2026-09-22T00:00:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-22T00:00:00.000Z' } }, true);
  db.upsert({ id: 'c-other-camera', event: { cameraId: 'cam-2', kind: 'person', firstUtc: '2026-09-01T00:00:00.000Z', lastUtc: '2026-09-01T00:00:05.000Z', count: 1, bestConfidence: 0.9, bestUtc: '2026-09-01T00:00:00.000Z' } }, true);
  eq(db.oldestFirstMs(['cam-1']), Date.parse('2026-09-20T00:00:00.000Z'), 'the earliest of THIS camera only, not cam-2\'s earlier one');
  db.close();
});

// ---------------------------------------------------------------------------
// agent/activity-run.mjs's combineHourBuckets: the min/max-across-cameras
// policy, unit-tested against synthetic per-camera ActivityBuckets.
// ---------------------------------------------------------------------------

const edge = { startUtc: '2026-09-24T12:00:00.000Z', endUtc: '2026-09-24T13:00:00.000Z' };
function bucket(overrides) {
  return { startUtc: edge.startUtc, endUtc: edge.endUtc, person: 0, vehicle: 0, hidden: 0, footageMin: 60, watchedMin: 60, status: 'counted', ...overrides };
}

check('combineHourBuckets: person/vehicle/hidden summed, footageMin the max, watchedMin the min, across two fully-watched cameras', () => {
  const perCamera = new Map([
    ['cam-1', [bucket({ person: 2, footageMin: 60, watchedMin: 60 })]],
    ['cam-2', [bucket({ person: 1, vehicle: 1, footageMin: 40, watchedMin: 30 })]],
  ]);
  const [combined] = combineHourBuckets([edge], perCamera, 'UTC', null, null);
  eq(combined.person, 3, 'summed');
  eq(combined.vehicle, 1, 'summed');
  eq(combined.footageMin, 60, 'the MAX across cameras');
  eq(combined.watchedMin, 30, 'the MIN across cameras -- the combined total is only as complete as the least-watched camera');
  eq(combined.status, 'partly_watched', 'watched 30 of 60 -- partly, even though cam-1 alone was fully watched');
});

check('REQUIRED: combineHourBuckets is null the moment ANY in-scope camera is unmeasured for that bucket, never averaged away', () => {
  const perCamera = new Map([
    ['cam-1', [bucket({ watchedMin: 60 })]],
    ['cam-2', [bucket({ watchedMin: null, status: 'watch_not_measured', watchedReason: 'watch time not measured' })]],
  ]);
  const [combined] = combineHourBuckets([edge], perCamera, 'UTC', null, null);
  eq(combined.watchedMin, null, 'REQUIRED: null, not cam-1\'s 60, and not an average');
  eq(combined.status, 'watch_not_measured', 'the whole combined bucket reads as unmeasured');
});

check('combineHourBuckets: a single camera reduces to exactly that camera\'s own numbers', () => {
  const perCamera = new Map([['cam-1', [bucket({ person: 4, vehicle: 2, hidden: 1, footageMin: 45, watchedMin: 20, status: 'partly_watched' })]]]);
  const [combined] = combineHourBuckets([edge], perCamera, 'UTC', null, null);
  same(combined, bucket({ person: 4, vehicle: 2, hidden: 1, footageMin: 45, watchedMin: 20, status: 'partly_watched' }), 'identical to the one camera');
});

// ---------------------------------------------------------------------------
// health-history.mjs: the `detecting` sample itself, from injected
// detect-health.json content.
// ---------------------------------------------------------------------------

await mustAwait('REQUIRED: detecting is 1 within 120s of lastFrameUtc or a gate window, 0 otherwise, and ONLY for a camera the file actually names', async () => {
  const dir = await tmpDir('camplat-activity-detecting-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, ['cam-1', 'cam-2', 'cam-3']);
  const atMs = Date.parse('2026-09-24T14:00:00.000Z');
  const now = () => new Date(atMs);
  const detectHealth = {
    atUtc: new Date(atMs).toISOString(),
    cameras: [
      { cameraId: 'cam-1', lastFrameUtc: new Date(atMs - 30_000).toISOString(), gate: null }, // 30s ago -- watching
      { cameraId: 'cam-2', lastFrameUtc: new Date(atMs - 500_000).toISOString(), gate: { lastWindow: { atUtc: new Date(atMs - 10_000).toISOString() } } }, // stale frame, but a fresh gate window -- watching
      // cam-3 has no entry at all -- must get no row, not a guessed 0.
    ],
  };
  const readFileFn = async (p) => {
    if (String(p).replace(/\\/g, '/').endsWith('detect-health.json')) return JSON.stringify(detectHealth);
    return enoent();
  };
  const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'win32', readFileFn, readdirFn: async () => [] });
  await hh.initialTick;
  const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
  eq(db.rangeFor('detecting', 'cam-1', 0, atMs + 1), [{ atMs, value: 1 }], 'cam-1: recent lastFrameUtc -> watching');
  eq(db.rangeFor('detecting', 'cam-2', 0, atMs + 1), [{ atMs, value: 1 }], 'cam-2: the gate window is what makes it recent, not the stale frame');
  eq(db.rangeFor('detecting', 'cam-3', 0, atMs + 1).length, 0, 'REQUIRED: cam-3 is not in the file -- no row at all, never a stored 0');
  db.close();
  await hh.close();
  index.close();
  await rm(dir, { recursive: true, force: true });
});

await mustAwait('REQUIRED: no detecting row for anyone when detect-health.json is missing, unreadable, or not shaped like the real file', async () => {
  for (const readFileFn of [
    enoent,
    async () => 'not json at all {{{',
    async () => JSON.stringify({ atUtc: 'x' }), // no `cameras` array
  ]) {
    const dir = await tmpDir('camplat-activity-nodetect-');
    await mkdir(join(dir, 'disk0'), { recursive: true });
    const index = openIndex(join(dir, 'index.db'));
    const config = makeConfig(dir, ['cam-1']);
    const atMs = Date.parse('2026-09-24T14:00:00.000Z');
    const now = () => new Date(atMs);
    const hh = startHealthHistory({ config, index, stateDir: dir, now, platform: 'win32', readFileFn, readdirFn: async () => [] });
    await hh.initialTick;
    const db = openHealthHistoryDb(join(dir, HEALTH_HISTORY_DB_FILE));
    eq(db.rangeFor('detecting', 'cam-1', 0, atMs + 1).length, 0, 'no row written for this failure mode');
    db.close();
    await hh.close();
    index.close();
    await rm(dir, { recursive: true, force: true });
  }
});

check('watchedMinutesFor: null before the first sample ever written, a real 0..60 after it, one instant shared by every camera', async () => {
  const dir = await tmpDir('camplat-activity-watchedmin-');
  await mkdir(join(dir, 'disk0'), { recursive: true });
  const index = openIndex(join(dir, 'index.db'));
  const config = makeConfig(dir, ['cam-1']);
  const dbFile = join(dir, HEALTH_HISTORY_DB_FILE);
  const measuredFromMs = Date.parse('2026-09-24T13:00:00.000Z');
  putDetectingSamples(dbFile, 'cam-1', [
    { atMs: measuredFromMs, value: 0 },
    { atMs: measuredFromMs + 5 * 60_000, value: 1 },
  ]);
  const hh = startHealthHistory({
    config, index, stateDir: dir, now: () => new Date('2026-09-24T15:00:00.000Z'),
    db: openHealthHistoryDb(dbFile), platform: 'win32', readFileFn: enoent, readdirFn: async () => [],
    intervalMs: 999999, pruneIntervalMs: 999999,
  });
  const edges = [
    { startUtc: '2026-09-24T12:00:00.000Z', endUtc: '2026-09-24T13:00:00.000Z' }, // before the first sample
    { startUtc: '2026-09-24T13:00:00.000Z', endUtc: '2026-09-24T14:00:00.000Z' }, // the hour it starts in
  ];
  const { watchMeasuredFromUtc, perCamera } = hh.watchedMinutesFor(['cam-1'], edges);
  eq(watchMeasuredFromUtc, new Date(measuredFromMs).toISOString(), 'the earliest sample ever');
  const minutes = perCamera.get('cam-1');
  eq(minutes[0], null, 'REQUIRED: before the sample existed -- null, not 0');
  eq(minutes[1], 1, 'one real 1-sample in this hour');
  await hh.close();
  index.close();
  await rm(dir, { recursive: true, force: true });
});

await mustAwait(
  'REQUIRED, THE FEARED ONE: two cameras with DIFFERENT own-earliest detecting samples -- the newer camera reads null for an hour before ITS OWN sample began, never borrowing the older camera\'s earlier instant',
  async () => {
    const dir = await tmpDir('camplat-activity-watchedmin2-');
    await mkdir(join(dir, 'disk0'), { recursive: true });
    const index = openIndex(join(dir, 'index.db'));
    const config = makeConfig(dir, ['cam-old', 'cam-new']);
    const dbFile = join(dir, HEALTH_HISTORY_DB_FILE);
    // cam-old has been sampled since day 1; cam-new (added to the site
    // later, or whose history was pruned separately) has not been sampled
    // until day 4 -- 3 days after cam-old's own first sample.
    const oldFirstMs = Date.parse('2026-09-01T00:00:00.000Z');
    const newFirstMs = Date.parse('2026-09-04T00:00:00.000Z');
    putDetectingSamples(dbFile, 'cam-old', [{ atMs: oldFirstMs, value: 1 }]);
    putDetectingSamples(dbFile, 'cam-new', [{ atMs: newFirstMs, value: 1 }]);
    const hh = startHealthHistory({
      config, index, stateDir: dir, now: () => new Date('2026-09-05T00:00:00.000Z'),
      db: openHealthHistoryDb(dbFile), platform: 'win32', readFileFn: enoent, readdirFn: async () => [],
      intervalMs: 999999, pruneIntervalMs: 999999,
    });
    // An hour on day 2: after cam-old's own first sample, but two full days
    // BEFORE cam-new's own first sample.
    const edges = [
      { startUtc: '2026-09-02T00:00:00.000Z', endUtc: '2026-09-02T01:00:00.000Z' },
    ];
    const { watchMeasuredFromUtc, perCamera } = hh.watchedMinutesFor(['cam-old', 'cam-new'], edges);
    eq(watchMeasuredFromUtc, new Date(oldFirstMs).toISOString(), 'the top-level envelope field is still the site-wide MIN (cam-old\'s), documented as site metadata');
    const oldMinutes = perCamera.get('cam-old');
    const newMinutes = perCamera.get('cam-new');
    eq(oldMinutes[0], 0, 'cam-old: this hour is after cam-old\'s own first sample -- a real, measured 0 (no 1-sample landed in it)');
    eq(
      newMinutes[0],
      null,
      'REQUIRED: cam-new\'s own bucket must be null (build rule 5: a blank is not a zero) -- this hour is BEFORE cam-new\'s own first sample, even though it is after cam-old\'s. Getting 0 here means the shared/global watchMeasuredFromUtc leaked cam-old\'s earlier instant into cam-new\'s own arithmetic.',
    );
    await hh.close();
    index.close();
    await rm(dir, { recursive: true, force: true });
  },
);

// ---------------------------------------------------------------------------
// The whole route, end to end: a real events.db, a real index.db, a real
// health-history.db, through the real HTTP server.
// ---------------------------------------------------------------------------

const dir = await tmpDir('camplat-activity-api-');
await mkdir(join(dir, 'disk0'), { recursive: true });
const config = makeConfig(dir, ['cam-1']);
const NOW_MS = Date.parse('2026-09-24T15:30:00.000Z');
const now = () => new Date(NOW_MS);

const index = openIndex(join(dir, 'index.db'));
// Footage for the two hours the test cares about, PLUS a long-ago segment
// covering the "earliest event" fixture below -- events retention
// (agent/event-retention.mjs) deletes an event once the index's own
// earliestFor(camera) has moved past it, and this test needs that event to
// still be there when the route reads oldestFirstMs.
index.put({ cameraId: 'cam-1', startUtc: '2026-09-09T00:00:00.000Z', endUtc: '2026-09-23T17:00:00.000Z', path: 'disk0/cam-1/old.mp4', bytes: 1_000_000, state: 'sealed', hold: false, pendingUpload: false, bitrateKbps: null, root: join(dir, 'disk0') });
index.put({ cameraId: 'cam-1', startUtc: '2026-09-24T13:00:00.000Z', endUtc: '2026-09-24T14:00:00.000Z', path: 'disk0/cam-1/a.mp4', bytes: 1_000_000, state: 'sealed', hold: false, pendingUpload: false, bitrateKbps: null, root: join(dir, 'disk0') });
index.put({ cameraId: 'cam-1', startUtc: '2026-09-24T14:00:00.000Z', endUtc: '2026-09-24T15:00:00.000Z', path: 'disk0/cam-1/b.mp4', bytes: 1_000_000, state: 'sealed', hold: false, pendingUpload: false, bitrateKbps: null, root: join(dir, 'disk0') });

putEvents(join(dir, 'events.db'), [
  // An old event, well outside the 24h window (so it is never fetched by
  // eventsInWindow, and does not inflate this test's totals). countsFromUtc
  // is NOT this event: it is the oldest VIDEO (the 2026-09-09 segment above),
  // since events live exactly as long as their footage.
  ev('a-earliest', 'person', '2026-09-10T00:00:00.000Z', 'cam-1'),
  // The fully-watched hour, 14:00-15:00: one person, one vehicle, one hidden.
  ev('b-person', 'person', '2026-09-24T14:10:00.000Z', 'cam-1'),
  ev('c-vehicle', 'vehicle', '2026-09-24T14:20:00.000Z', 'cam-1'),
  ev('d-hidden', 'person', '2026-09-24T14:30:00.000Z', 'cam-1', { suppressedBy: 'obj-1' }),
]);

// detecting: 13:00-14:00 is measured but entirely 0 (not watching); 14:00-15:00
// is measured and entirely 1 (fully watched). Nothing before 13:00 -- the
// 2026-09-23 hour (the one that sets countsFromUtc above) is genuinely
// unmeasured, and this test does not assert its status, only the two below.
{
  const hhFile = join(dir, HEALTH_HISTORY_DB_FILE);
  const rows = [];
  for (let m = 0; m < 60; m++) rows.push({ atMs: Date.parse('2026-09-24T13:00:00.000Z') + m * 60_000, value: 0 });
  for (let m = 0; m < 60; m++) rows.push({ atMs: Date.parse('2026-09-24T14:00:00.000Z') + m * 60_000, value: 1 });
  putDetectingSamples(hhFile, 'cam-1', rows);
}

const server = createApiServer({
  stateDir: dir, config, index, now, auth: installerAuth,
  healthHistoryEnabled: true,
  healthHistoryOverrides: { platform: 'win32', readFileFn: enoent, readdirFn: async () => [] },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const fetchJson = async (url, auth) => {
  const res = await fetch(url, auth ? { headers: { 'x-test-auth': auth } } : undefined);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
};

await mustAwait('GET /activity?range=24h&tz=UTC: real counts, a hidden event counted only in hidden, and the right status per hour', async () => {
  const { res, json } = await fetchJson(`${base}/activity?range=24h&tz=UTC`);
  eq(res.status, 200, 'status');
  eq(json.ok, true, 'ok');
  eq(json.available, true, 'events.db exists');
  eq(json.countsFromUtc, '2026-09-09T00:00:00.000Z', 'the oldest video this NVR still holds, not the oldest sighting');
  eq(json.watchMeasuredFromUtc, '2026-09-24T13:00:00.000Z', 'the earliest detecting sample');

  const busy = json.buckets.find((b) => b.startUtc === '2026-09-24T14:00:00.000Z');
  eq(busy.person, 1, 'one real person sighting');
  eq(busy.vehicle, 1, 'one real vehicle sighting');
  eq(busy.hidden, 1, 'REQUIRED: the suppressed event counted in hidden, and only there');
  eq(busy.watchedMin, 60, 'the fully-watched hour');
  eq(busy.status, 'counted', 'measured, watched, and video held');

  const quiet = json.buckets.find((b) => b.startUtc === '2026-09-24T13:00:00.000Z');
  eq(quiet.person, 0, 'no sightings this hour');
  eq(quiet.vehicle, 0, 'no sightings this hour');
  eq(quiet.watchedMin, 0, 'REQUIRED: a real, measured 0 -- not null');
  eq(quiet.status, 'not_watching', 'REQUIRED: the right status for a real 0, never presented as watched');

  const unmeasured = json.buckets.find((b) => b.startUtc === '2026-09-24T00:00:00.000Z');
  eq(unmeasured.watchedMin, null, 'REQUIRED: an hour before watchMeasuredFromUtc is null on the wire, not a guessed 0');
  eq(unmeasured.status, 'watch_not_measured', 'the matching status');
  eq(typeof unmeasured.watchedReason, 'string', 'a reason accompanies the null');

  eq(json.totals.person, 1, 'combined totals: one person over the whole 24h');
  eq(json.totals.vehicle, 1, 'combined totals: one vehicle');
  eq(json.busiestHour.startUtc, '2026-09-24T14:00:00.000Z', 'the busiest WATCHED hour');
  eq(json.perCamera.length, 1, 'one entry -- the one configured camera');
  eq(json.perCamera[0].cameraId, 'cam-1', 'by id');
  same(json.perCamera[0].buckets.find((b) => b.startUtc === '2026-09-24T14:00:00.000Z'), busy, 'the single camera\'s own bucket matches the combined one exactly');
});

await mustAwait('GET /activity?camera=cam-1: the same one-camera view, filtered', async () => {
  const { res, json } = await fetchJson(`${base}/activity?range=24h&tz=UTC&camera=cam-1`);
  eq(res.status, 200, 'status');
  eq(json.camera, 'cam-1', 'echoes the filter');
  eq(json.perCamera.length, 1, 'one camera in scope');
});

await mustAwait('REQUIRED: a bad range, tz or camera is 400, never silently coerced', async () => {
  const badRange = await fetchJson(`${base}/activity?range=1d&tz=UTC`);
  eq(badRange.res.status, 400, 'bad range status');
  eq(badRange.json.code, 'bad_range', 'bad range code');

  const badTz = await fetchJson(`${base}/activity?range=24h&tz=Not/AZone`);
  eq(badTz.res.status, 400, 'bad tz status');
  eq(badTz.json.code, 'bad_tz', 'bad tz code');

  const badCamera = await fetchJson(`${base}/activity?range=24h&tz=UTC&camera=${encodeURIComponent('bad id!')}`);
  eq(badCamera.res.status, 400, 'bad camera status');
  eq(badCamera.json.code, 'bad_camera_id', 'bad camera code');
});

check('the store role gets 200 on /activity, and a display gets 403 -- events.view, never playback.view', () => {
  const installer = { kind: 'user', username: 'tech', role: 'installer' };
  const store = { kind: 'user', username: 'clerk', role: 'store' };
  const display = { kind: 'display', displayId: 'wall-1' };
  eq(decideRoute(installer, 'GET', '/activity').kind, 'allow', 'installer');
  eq(decideRoute(store, 'GET', '/activity').kind, 'allow', 'store has events.view');
  eq(decideRoute(display, 'GET', '/activity').kind, 'refuse', 'REQUIRED: a display never sees this (spec: "A display never sees it")');
  eq(decideRoute(display, 'GET', '/activity').status, 403, 'forbidden, not a redirect -- an API route, not a page');
  eq(decideRoute(installer, 'GET', '/activity-page').kind, 'allow', 'the page too');
  eq(decideRoute(display, 'GET', '/activity-page').kind, 'refuse', 'and the page the same way');
});

await mustAwait('the store role really gets 200 through the live server, and a display really gets 403', async () => {
  const storePrincipal = { kind: 'user', username: 'clerk', role: 'store' };
  const displayPrincipal = { kind: 'display', displayId: 'wall-1' };
  const storeServer = createApiServer({
    stateDir: dir, config, index, now, auth: authAs(storePrincipal),
    healthHistoryEnabled: true, healthHistoryOverrides: { platform: 'win32', readFileFn: enoent, readdirFn: async () => [] },
  });
  await new Promise((resolve) => storeServer.listen(0, '127.0.0.1', resolve));
  const storeBase = `http://127.0.0.1:${storeServer.address().port}`;
  const storeResult = await fetchJson(`${storeBase}/activity?range=24h&tz=UTC`);
  eq(storeResult.res.status, 200, 'store: 200');
  storeServer.closeEventRetention();
  storeServer.closeHealthHistory();
  storeServer.closeEvents();
  storeServer.close();

  const displayServer = createApiServer({
    stateDir: dir, config, index, now, auth: authAs(displayPrincipal),
    healthHistoryEnabled: true, healthHistoryOverrides: { platform: 'win32', readFileFn: enoent, readdirFn: async () => [] },
  });
  await new Promise((resolve) => displayServer.listen(0, '127.0.0.1', resolve));
  const displayBase = `http://127.0.0.1:${displayServer.address().port}`;
  const displayResult = await fetchJson(`${displayBase}/activity?range=24h&tz=UTC`);
  eq(displayResult.res.status, 403, 'display: 403');
  displayServer.closeEventRetention();
  displayServer.closeHealthHistory();
  displayServer.closeEvents();
  displayServer.close();
});

server.closeEventRetention();
server.closeHealthHistory();
server.closeEvents();
server.close();
index.close();

await mustAwait('REQUIRED: available:false when there is no events.db at all, the same way /events answers it', async () => {
  const dir2 = await tmpDir('camplat-activity-noevents-');
  await mkdir(join(dir2, 'disk0'), { recursive: true });
  const index2 = openIndex(join(dir2, 'index.db'));
  const config2 = makeConfig(dir2, ['cam-1']);
  const server2 = createApiServer({ stateDir: dir2, config: config2, index: index2, now: () => new Date('2026-09-24T15:30:00.000Z'), auth: installerAuth });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  const { res, json } = await fetchJson(`${base2}/activity?range=24h&tz=UTC`);
  eq(res.status, 200, 'REQUIRED: not an error -- the same 200/available:false shape /events uses');
  eq(json.ok, true, 'ok');
  eq(json.available, false, 'REQUIRED: available:false, not a fabricated empty-but-measured response');
  same(json.buckets, [], 'no buckets to report');
  eq(json.countsFromUtc, null, 'nothing to report');
  eq(json.watchMeasuredFromUtc, null, 'nothing to report');
  server2.closeEventRetention();
  server2.close();
  index2.close();
  await rm(dir2, { recursive: true, force: true });
});

await mustAwait('REQUIRED, THE FEARED ONE: a camera configured with user:pass never reaches the /activity JSON', async () => {
  const { json, text } = await (async () => {
    const dir3 = await tmpDir('camplat-activity-secret-');
    await mkdir(join(dir3, 'disk0'), { recursive: true });
    const index3 = openIndex(join(dir3, 'index.db'));
    const config3 = makeConfig(dir3, ['cam-1']);
    putEvents(join(dir3, 'events.db'), [ev('a', 'person', '2026-09-24T14:10:00.000Z', 'cam-1')]);
    const server3 = createApiServer({ stateDir: dir3, config: config3, index: index3, now: () => new Date('2026-09-24T15:30:00.000Z'), auth: installerAuth });
    await new Promise((resolve) => server3.listen(0, '127.0.0.1', resolve));
    const base3 = `http://127.0.0.1:${server3.address().port}`;
    const result = await fetchJson(`${base3}/activity?range=24h&tz=UTC`);
    server3.closeEventRetention();
    server3.closeEvents();
    server3.close();
    index3.close();
    await rm(dir3, { recursive: true, force: true });
    return result;
  })();
  eq(json.ok, true, 'sanity: this really is the activity response');
  for (const secret of ['hunter2', 'svc:hunter2', 'rtsp://']) {
    eq(text.includes(secret), false, `${secret} must never appear in the /activity JSON`);
  }
  eq(text.includes('cam-1'), true, 'the bare camera id is still there');
});

await rm(dir, { recursive: true, force: true });

check('THE FEARED ONE: a recorded, watched, quiet night is a real 0 - counts reach back to the OLDEST VIDEO, not the oldest sighting', () => {
  // Found 2026-09-26: keyed on the oldest sighting, the hours between the
  // footage starting (00:00) and the first person (08:15) read "before this
  // NVR's oldest video" although they were recorded and watched.
  const footageFrom = '2026-09-26T00:00:00.000Z';
  const firstPersonMs = Date.parse('2026-09-26T08:15:00.000Z');
  const ctx = {
    config: { cameras: [{ cameraId: 'cam-1' }] },
    index: {
      earliestFor: () => footageFrom,
      inRange: () => [{ startUtc: footageFrom, endUtc: '2026-09-26T12:30:00.000Z' }],
    },
    eventsDb: {
      eventsInWindow: () => [{ cameraId: 'cam-1', kind: 'person', firstMs: firstPersonMs, suppressedBy: null }],
      oldestFirstMs: () => firstPersonMs,
    },
    healthHistory: {
      watchedMinutesFor: (ids, edges) => ({
        watchMeasuredFromUtc: '2026-09-25T00:00:00.000Z',
        perCamera: new Map(ids.map((id) => [id, edges.map(() => 60)])),
      }),
    },
    now: () => new Date('2026-09-26T12:30:00.000Z'),
  };
  const res = buildActivityResponse(ctx, { range: '24h', tz: 'UTC', camera: null });
  eq(res.countsFromUtc, footageFrom, 'counts reach back to the oldest video');
  const at = (iso) => res.buckets.find((b) => b.startUtc === iso);
  eq(at('2026-09-26T03:00:00.000Z').status, 'counted', '03:00 had video and was watched: counted');
  eq(at('2026-09-26T03:00:00.000Z').person, 0, 'and its count is a real 0');
  eq(at('2026-09-26T08:00:00.000Z').person, 1, 'the one sighting is in its own hour');
  eq(at('2026-09-25T20:00:00.000Z').status, 'before_oldest_video', 'before the footage starts it is NOT a 0');
});

report('activity run');
