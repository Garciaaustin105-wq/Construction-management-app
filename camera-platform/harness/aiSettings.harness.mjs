// harness/aiSettings.harness.mjs — contracts/aiSettings.ts
//
// FEARED: a plate stored while the switch is off; a switch flip with no audit
// line naming who did it; a stored read that never expires.

import { check, eq, report } from "./_assert.mjs";
import {
  DEFAULT_AI_SETTINGS, MAX_PLATE_RETENTION_DAYS,
  checkAiSettings, setPlateReading, admitDetection, plateReadExpired,
} from "../dist/aiSettings.js";

console.log("ai settings");

const AT = "2026-09-16T20:00:00.000Z";
const on = { platesEnabled: true, plateRetentionDays: 30 };
const off = { platesEnabled: false, plateRetentionDays: 30 };
const det = (kind) => ({
  cameraId: "gate", atUtc: AT, kind, confidence: 0.9, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  ...(kind === "plate" ? { plate: "ABC123" } : {}),
});

check("plate reading starts off, with 30 days retention", () => {
  eq(DEFAULT_AI_SETTINGS, { platesEnabled: false, plateRetentionDays: 30 });
  eq(Object.isFrozen(DEFAULT_AI_SETTINGS), true);
  eq(MAX_PLATE_RETENTION_DAYS, 365);
});

check("checkAiSettings accepts good settings as a new object", () => {
  const raw = { plateRetentionDays: 7, platesEnabled: true, extra: 1 };
  const r = checkAiSettings(raw);
  eq(r, { ok: true, settings: { platesEnabled: true, plateRetentionDays: 7 } });
  if (r.settings === raw) throw new Error("returned the caller's object");
  eq(checkAiSettings({ platesEnabled: false, plateRetentionDays: 365 }).ok, true);
  eq(checkAiSettings({ platesEnabled: false, plateRetentionDays: 1 }).ok, true);
});

check("checkAiSettings refuses bad settings", () => {
  const refuse = (raw, reason) => eq(checkAiSettings(raw), { ok: false, reason });
  refuse(null, "not_an_object");
  refuse([], "not_an_object");
  refuse("on", "not_an_object");
  refuse({ platesEnabled: "true", plateRetentionDays: 30 }, "bad_plates_enabled");
  refuse({ platesEnabled: 1, plateRetentionDays: 30 }, "bad_plates_enabled");
  refuse({ plateRetentionDays: 30 }, "bad_plates_enabled");
  refuse({ platesEnabled: true, plateRetentionDays: 0 }, "bad_retention");
  refuse({ platesEnabled: true, plateRetentionDays: 366 }, "bad_retention");
  refuse({ platesEnabled: true, plateRetentionDays: 2.5 }, "bad_retention");
  refuse({ platesEnabled: true, plateRetentionDays: "30" }, "bad_retention");
  refuse({ platesEnabled: true, plateRetentionDays: Infinity }, "bad_retention");
});

check("FEARED: turning plates off produces an audit entry naming who did it", () => {
  const before = JSON.stringify(on);
  eq(setPlateReading(on, false, "austin", AT), {
    ok: true, changed: true,
    settings: { platesEnabled: false, plateRetentionDays: 30 },
    audit: { event: "plates_disabled", actor: "austin", atUtc: AT },
  });
  eq(JSON.stringify(on), before);
  eq(setPlateReading(off, true, "austin", AT).audit, { event: "plates_enabled", actor: "austin", atUtc: AT });
});

check("a no-op flip changes nothing and writes no audit line", () => {
  const r = setPlateReading(off, false, "austin", AT);
  eq(r, { ok: true, changed: false, settings: off });
  if (r.settings === off) throw new Error("returned the caller's object");
});

check("a flip with no actor, a bad time, or a non-boolean is refused", () => {
  eq(setPlateReading(on, false, "", AT), { ok: false, reason: "bad_actor" });
  eq(setPlateReading(on, false, null, AT), { ok: false, reason: "bad_actor" });
  eq(setPlateReading(on, false, "austin", "later"), { ok: false, reason: "bad_time" });
  eq(setPlateReading(on, "false", "austin", AT), { ok: false, reason: "bad_enabled" });
  eq(setPlateReading(on, 0, "austin", AT), { ok: false, reason: "bad_enabled" });
});

check("FEARED: no plate is stored while the switch is off", () => {
  eq(admitDetection(off, det("plate")), { store: false, reason: "plates_off" });
  eq(admitDetection({ plateRetentionDays: 30 }, det("plate")), { store: false, reason: "plates_off" });
  eq(admitDetection({ platesEnabled: "yes", plateRetentionDays: 30 }, det("plate")), { store: false, reason: "plates_off" });
  eq(admitDetection(on, det("plate")), { store: true });
});

check("people and vehicles do not depend on the plate switch", () => {
  eq(admitDetection(off, det("person")), { store: true });
  eq(admitDetection(off, det("vehicle")), { store: true });
});

check("FEARED: stored reads expire on schedule, switch on or off", () => {
  const read = "2026-08-17T20:00:00.000Z"; // exactly 30 days before AT
  eq(plateReadExpired(on, read, AT), true);
  eq(plateReadExpired(off, read, AT), true);
  eq(plateReadExpired(on, read, "2026-09-16T19:59:59.999Z"), false);
  eq(plateReadExpired({ platesEnabled: false, plateRetentionDays: 7 }, "2026-09-09T20:00:00.000Z", AT), true);
  eq(plateReadExpired({ platesEnabled: false, plateRetentionDays: 7 }, "2026-09-10T20:00:00.000Z", AT), false);
});

report("ai settings");
