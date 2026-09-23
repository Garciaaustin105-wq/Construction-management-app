/**
 * contracts/deviceCheckin.ts: shaping a signed check-in payload from
 * measured facts (CLOUD-B1-SPEC.md section 6; B1 phase-1 brief, piece 2).
 *
 * The failure feared most (build rule 19): a secret slips into what leaves
 * the box. THE FEARED ONE below fuzzes a facts object with a marked secret
 * planted at every plausible spot -- inside a camera, a drive, each
 * sub-object, and at the top level -- and proves it reaches neither the
 * built payload nor a thrown error's message. Everything else here checks
 * the payload is reproducible (same facts -> byte-identical canonical JSON,
 * whatever order the caller's own arrays or object keys happened to be in)
 * and that buildCheckin refuses malformed input rather than guessing past
 * it (build rule 10).
 */
import { randomBytes } from "node:crypto";
import { buildCheckin, canonicalJson, checkinDigest, CHECKIN_SCHEMA_VERSION } from "../dist/deviceCheckin.js";
import { check, eq, same, throws, report } from "./_assert.mjs";

console.log("deviceCheckin");

const NOW = "2026-09-23T12:00:00.000Z";

function baseFacts(over = {}) {
  return {
    version: "a".repeat(40),
    uptimeSec: 3600,
    cameras: [
      { cameraId: "cam1", recording: true, detecting: "watching", gateShare: 0.42, lastSealedUtc: "2026-09-23T11:55:00.000Z" },
      { cameraId: "cam2", recording: false, detecting: null, gateShare: null, lastSealedUtc: null },
    ],
    drives: [
      { index: 0, fillFraction: 0.5 },
      { index: 1, fillFraction: null },
    ],
    footageHeld: { hours: 48, basis: "measured", refusedReason: null },
    detector: { capacityFps: 8, minConfidence: 0.5, motionGateEnabled: true },
    knownObjects: { active: 2, lapsed: 1 },
    lastSealedUtc: "2026-09-23T11:55:00.000Z",
    ...over,
  };
}
const opts = (over = {}) => ({ deviceId: "device-abc123", nowUtc: NOW, seq: 1, ...over });

/* ── shape and determinism ──────────────────────────────────────────── */

await check("a well-formed facts object builds a payload with checkinVersion, deviceId, seq, sentAtUtc, and the health facts nested", () => {
  const payload = buildCheckin(baseFacts(), opts());
  eq(payload.checkinVersion, CHECKIN_SCHEMA_VERSION, "schema version");
  eq(payload.deviceId, "device-abc123", "deviceId");
  eq(payload.seq, 1, "seq");
  eq(payload.sentAtUtc, NOW, "sentAtUtc");
  eq(payload.health.cameras.length, 2, "both cameras kept");
  eq(payload.health.drives.length, 2, "both drives kept");
});

await check("buildCheckin is pure: identical arguments always canonicalize to identical bytes", () => {
  const a = canonicalJson(buildCheckin(baseFacts(), opts()));
  const b = canonicalJson(buildCheckin(baseFacts(), opts()));
  eq(a, b, "same canonical JSON");
});

await check("cameras and drives are sorted into a fixed order, regardless of the order the caller's own facts gave them in", () => {
  const forward = baseFacts();
  const reversed = baseFacts({
    cameras: [...forward.cameras].reverse(),
    drives: [...forward.drives].reverse(),
  });
  const a = canonicalJson(buildCheckin(forward, opts()));
  const b = canonicalJson(buildCheckin(reversed, opts()));
  eq(a, b, "order of the caller's arrays does not change the signed bytes");
});

await check("canonicalJson does not depend on an object's own key insertion order", () => {
  const x = { b: 2, a: 1, c: { z: 9, y: 8 } };
  const y = { c: { y: 8, z: 9 }, a: 1, b: 2 };
  eq(canonicalJson(x), canonicalJson(y), "reordered keys, same value, same canonical text");
});

await check("checkinDigest changes when the seq changes, or a camera field changes, or one character does", () => {
  const p1 = buildCheckin(baseFacts(), opts({ seq: 1 }));
  const p2 = buildCheckin(baseFacts(), opts({ seq: 2 }));
  eq(checkinDigest(p1) === checkinDigest(p2), false, "seq alone changes the digest");

  const p3 = buildCheckin(baseFacts(), opts());
  const alteredFacts = baseFacts();
  alteredFacts.cameras[0].gateShare = 0.43; // one field, one camera
  const p4 = buildCheckin(alteredFacts, opts());
  eq(checkinDigest(p3) === checkinDigest(p4), false, "a single camera field changes the digest");

  const p5 = buildCheckin(baseFacts(), opts({ deviceId: "device-abc124" })); // one character different
  eq(checkinDigest(p3) === checkinDigest(p5), false, "a one-character deviceId change changes the digest");
});

await check("checkinDigest agrees for the SAME payload built with a differently-ordered facts object", () => {
  // buildCheckin's own output is what gets hashed, so re-ordering the INPUT
  // object's own keys (not its arrays, covered above) must not matter either.
  const f1 = baseFacts();
  const f2 = { lastSealedUtc: f1.lastSealedUtc, knownObjects: f1.knownObjects, detector: f1.detector,
    footageHeld: f1.footageHeld, drives: f1.drives, cameras: f1.cameras, uptimeSec: f1.uptimeSec, version: f1.version };
  eq(checkinDigest(buildCheckin(f1, opts())), checkinDigest(buildCheckin(f2, opts())), "same digest");
});

/* ── refusals (build rule 10: refuse rather than guess) ─────────────── */

// One valid camera / drive to mutate a single field on, so each case below
// isolates exactly the field it claims to -- a case built from a
// half-empty object can throw for the WRONG reason and still pass, which is
// exactly what the mutation-check below this caught the first time round.
const oneCamera = () => ({ cameraId: "cam1", recording: true, detecting: "watching", gateShare: 0.5, lastSealedUtc: "2026-09-23T11:00:00.000Z" });
const oneDrive = () => ({ index: 0, fillFraction: 0.5 });

await check("buildCheckin refuses structurally wrong facts, rather than guessing", () => {
  throws(() => buildCheckin(null, opts()), "null facts");
  throws(() => buildCheckin("nope", opts()), "facts as a string");
  throws(() => buildCheckin(baseFacts({ uptimeSec: "3600" }), opts()), "uptimeSec as a string");
  throws(() => buildCheckin(baseFacts({ uptimeSec: -1 }), opts()), "negative uptimeSec");
  throws(() => buildCheckin(baseFacts({ cameras: "not an array" }), opts()), "cameras not an array");
  throws(() => buildCheckin(baseFacts({ cameras: [{ ...oneCamera(), cameraId: undefined }] }), opts()), "camera with no cameraId");
  throws(() => buildCheckin(baseFacts({ cameras: [{ ...oneCamera(), gateShare: 1.5 }] }), opts()), "gateShare out of range");
  throws(() => buildCheckin(baseFacts({ cameras: [{ ...oneCamera(), lastSealedUtc: "not a date" }] }), opts()), "unparsable lastSealedUtc");
  throws(() => buildCheckin(baseFacts({ drives: [{ ...oneDrive(), index: -1 }] }), opts()), "negative drive index");
  throws(() => buildCheckin(baseFacts({ drives: [{ ...oneDrive(), index: 1.5 }] }), opts()), "non-integer drive index");
  throws(() => buildCheckin(baseFacts({ footageHeld: { hours: "48", basis: null, refusedReason: null } }), opts()), "footageHeld.hours as a string");
  throws(() => buildCheckin(baseFacts({ detector: { capacityFps: null, minConfidence: 2, motionGateEnabled: null } }), opts()), "minConfidence out of range");
  throws(() => buildCheckin(baseFacts({ knownObjects: { active: -1, lapsed: null } }), opts()), "negative knownObjects.active");
  throws(() => buildCheckin(baseFacts({ lastSealedUtc: "whenever" }), opts()), "unparsable top-level lastSealedUtc");
});

await check("buildCheckin refuses a malformed opts, rather than guessing", () => {
  throws(() => buildCheckin(baseFacts(), { deviceId: "", nowUtc: NOW, seq: 1 }), "empty deviceId");
  throws(() => buildCheckin(baseFacts(), { deviceId: "d", nowUtc: "whenever", seq: 1 }), "unparsable nowUtc");
  throws(() => buildCheckin(baseFacts(), { deviceId: "d", nowUtc: NOW, seq: -1 }), "negative seq");
  throws(() => buildCheckin(baseFacts(), { deviceId: "d", nowUtc: NOW, seq: 1.5 }), "non-integer seq");
  throws(() => buildCheckin(baseFacts(), { deviceId: "d", nowUtc: NOW, seq: Number.MAX_SAFE_INTEGER + 10 }), "unsafe seq");
});

await check("null/missing optional fields are accepted -- a blank is not refused, only a wrong type is", () => {
  const p = buildCheckin(
    baseFacts({
      version: null,
      cameras: [{ cameraId: "c", recording: null, detecting: null, gateShare: null, lastSealedUtc: null }],
      drives: [],
      footageHeld: { hours: null, basis: null, refusedReason: "unmeasured" },
      knownObjects: { active: null, lapsed: null },
      lastSealedUtc: null,
    }),
    opts(),
  );
  same(p.health.cameras[0], { cameraId: "c", recording: null, detecting: null, gateShare: null, lastSealedUtc: null }, "nulls pass through, not zeros");
});

/* ============================ THE FEARED ONE ========================= */
// Every secret the box could plausibly hold, planted at every plausible
// spot in a facts object that is otherwise perfectly well-formed (so
// buildCheckin does NOT refuse it -- a refusal would dodge the question).
// None of it may reach the built payload's canonical JSON, or any thrown
// error's message anywhere in this file.

await check("THE FEARED ONE: no camera password, user name, rtsp URL, or the device's own private key ever reaches a built payload", () => {
  const marks = {
    camPassword: `MARK-camPW-${randomBytes(8).toString("hex")}`,
    camUser: `MARK-camUser-${randomBytes(8).toString("hex")}`,
    rtspUrl: `MARK-rtsp-${randomBytes(8).toString("hex")}`,
    driveRoot: `MARK-root-${randomBytes(8).toString("hex")}`,
    sitePassword: `MARK-sitePW-${randomBytes(8).toString("hex")}`,
    devicePrivateKey: `MARK-devKey-${randomBytes(8).toString("hex")}`,
    apiKey: `MARK-api-${randomBytes(8).toString("hex")}`,
  };
  const evilFacts = baseFacts({
    cameras: [
      {
        cameraId: "cam1", recording: true, detecting: "watching", gateShare: 0.5, lastSealedUtc: "2026-09-23T11:00:00.000Z",
        // every extra property a real camera config or health snapshot bug
        // could plausibly attach here:
        url: `rtsp://${marks.camUser}:${marks.camPassword}@192.168.1.64/Streaming/Channels/101`,
        username: marks.camUser,
        password: marks.camPassword,
        credentials: { username: marks.camUser, password: marks.camPassword },
        reason: `could not connect to ${marks.rtspUrl}`,
      },
    ],
    drives: [{ index: 0, fillFraction: 0.5, root: `/srv/camplat/disk0-${marks.driveRoot}` }],
    footageHeld: { hours: 48, basis: "measured", refusedReason: null, note: marks.sitePassword },
    detector: { capacityFps: 8, minConfidence: 0.5, motionGateEnabled: true, apiKey: marks.apiKey },
    knownObjects: { active: 1, lapsed: 0, storePassword: marks.sitePassword },
  });
  evilFacts.credentials = { username: "installer", password: marks.sitePassword };
  evilFacts.devicePrivateKeyPem = `-----BEGIN PRIVATE KEY-----\n${marks.devicePrivateKey}\n-----END PRIVATE KEY-----`;

  const payload = buildCheckin(evilFacts, opts());
  const text = canonicalJson(payload);
  const alsoText = JSON.stringify(payload);
  for (const [name, mark] of Object.entries(marks)) {
    eq(text.includes(mark), false, `canonicalJson must not contain ${name}`);
    eq(alsoText.includes(mark), false, `JSON.stringify must not contain ${name}`);
  }
  // Structural check too, not just substring luck: every key actually
  // present is one buildCheckin is documented to produce.
  same(Object.keys(payload.health.cameras[0]).sort(), ["cameraId", "detecting", "gateShare", "lastSealedUtc", "recording"], "camera keys are exactly the allowed ones");
  same(Object.keys(payload.health.drives[0]).sort(), ["fillFraction", "index"], "drive keys are exactly the allowed ones");
  same(Object.keys(payload.health).sort(), ["cameras", "detector", "drives", "footageHeld", "knownObjects", "lastSealedUtc", "uptimeSec", "version"], "health keys are exactly the allowed ones");
});

await check("THE FEARED ONE: a refusal's error message never contains a value from facts, even a marked secret", () => {
  const mark = `MARK-refuse-${randomBytes(8).toString("hex")}`;
  const attempts = [
    () => buildCheckin(baseFacts({ version: mark, uptimeSec: "not a number" }), opts()),
    () => buildCheckin(baseFacts({ cameras: [{ cameraId: mark, gateShare: "not a number" }] }), opts()),
    () => buildCheckin(baseFacts(), { deviceId: mark, nowUtc: "not a date", seq: 1 }),
  ];
  for (const attempt of attempts) {
    let message = "";
    try {
      attempt();
      throw new Error("expected buildCheckin to refuse");
    } catch (err) {
      message = err.message;
    }
    eq(message.includes(mark), false, `refusal message must not echo the planted value: ${message}`);
  }
});

report("deviceCheckin");
