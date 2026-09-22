/**
 * Runs detector/test_motion_gate.py (whether the detector looks at a frame at
 * all) when Python with numpy is present; skips LOUDLY when it is not, like
 * yoloxPost does. Then checks that the gate's copy of the fold's merge gap is
 * the fold's: motion_gate.py sizes its hold rate so a still person stays one
 * event, and that sum is only true against the MERGE_GAP_MS the fold uses.
 * Then that the reasons the worker can report are the ones the service
 * accepts, and, end to end, that what a gated worker finds folds into the
 * events live would store (found in review, 2026-09-21: the Python tests
 * counted looks and never ran the fold, which joins by place as well as time).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { MERGE_GAP_MS, foldDetections } from "../dist/detection.js";
import { GATE_REASONS } from "../dist/detectStream.js";

const candidates = [process.env.CAMPLAT_PYTHON, "python3", "python"].filter(Boolean);
let python = null;
for (const c of candidates) {
  const r = spawnSync(c, ["-c", "import numpy"], { encoding: "utf8" });
  if (r.status === 0) { python = c; break; }
}
if (python === null) {
  console.log("motion gate\n  SKIP no Python with numpy here (set CAMPLAT_PYTHON to the detector venv's python)");
  console.log("motion gate: 0 passed, 0 failed (skipped)");
  process.exit(0);
}
const detector = path.join(import.meta.dirname, "..", "detector");
const tests = spawnSync(python, [path.join(detector, "test_motion_gate.py")], { stdio: "inherit" });

// The drift check, run through Python so it reads the module as the worker does.
const probe = spawnSync(python, ["-c", "import motion_gate as g; print(g.MERGE_GAP_MS, g.HOLD_INTERVAL_MS, g.TRACK_MEMORY_MS)"],
  { cwd: detector, encoding: "utf8" });
const [gap, hold, memory] = probe.stdout.trim().split(/\s+/).map(Number);
const drift = [];
if (gap !== MERGE_GAP_MS) drift.push(`motion_gate.MERGE_GAP_MS is ${gap}, contracts/detection.ts says ${MERGE_GAP_MS}`);
if (!(hold * 3 <= MERGE_GAP_MS)) drift.push(`a hold of ${hold} ms no longer fits three looks in the fold's ${MERGE_GAP_MS} ms merge gap`);
if (memory !== MERGE_GAP_MS) drift.push(`tracking lasts ${memory} ms, the fold keeps an event open ${MERGE_GAP_MS} ms`);
const results = [];
results.push(drift.length === 0
  ? { ok: true, name: `the gate's merge gap is the fold's (${MERGE_GAP_MS} ms), and three holds fit inside it` }
  : { ok: false, name: drift.join("; ") });

// The reasons the worker counts are the ones parseWorkerLine accepts. A
// reason the service does not know makes every gate line "bad_gate", and the
// camera's load stops being reported without anything failing loudly.
const reasons = spawnSync(python, ["-c", "import json, motion_gate as g; print(json.dumps(list(g.LOOK_REASONS)))"],
  { cwd: detector, encoding: "utf8" });
let pyReasons = null;
try { pyReasons = JSON.parse(reasons.stdout); } catch { /* reported below */ }
const same = Array.isArray(pyReasons) && pyReasons.length === GATE_REASONS.length && pyReasons.every((r, i) => r === GATE_REASONS[i]);
results.push({ ok: same, name: same
  ? `the worker's look reasons are the service's (${GATE_REASONS.join(", ")})`
  : `motion_gate.LOOK_REASONS is ${reasons.stdout.trim() || reasons.stderr.trim()}, contracts/detectStream.ts GATE_REASONS is ${JSON.stringify(GATE_REASONS)}` });

// End to end through the real fold. A person-sized box drifts 4 px a frame
// for 24 s: too little change for the whole-scene threshold. One look is
// scored under the live floor (0.5), as a turned-away pose is. What is kept
// is folded exactly as the live service folds it. Run twice: with the gate
// as built, and with its local-motion rule switched off, to prove the
// scenario is the one that splits.
const SCENARIO = `
import json, sys
import numpy as np
import motion_gate as g
if sys.argv[1] == "off":
    g.LOCAL_THRESHOLD = 2.0  # no share of cells can reach it
gate = g.Gate(640, 360, track_floor=0.5)
out, weak_done = [], False
for i in range(120):
    fr = np.full((640, 640, 3), 0x72, dtype=np.uint8)
    fr[:360, :, :] = 90
    x = 40 + i * 4
    fr[130:230, x:x + 40, :] = 200
    box = {"x": x / 640, "y": 130 / 360, "w": 40 / 640, "h": 100 / 360}
    t = i * 200
    if gate.should_look(fr, t):
        conf = 0.9
        if i >= 30 and not weak_done:
            conf, weak_done = 0.3, True
        dets = [{"kind": "person", "species": "person", "confidence": conf, "box": box}]
        gate.looked(dets, t)
        out.append({"t": t, "dets": dets})
print(json.dumps({"looks": out, "totals": gate.totals()}))
`;
const T0 = Date.parse("2026-09-21T20:00:00Z");
function foldScenario(mode) {
  const r = spawnSync(python, ["-c", SCENARIO, mode], { cwd: detector, encoding: "utf8" });
  if (r.status !== 0) return { error: r.stderr.trim().split("\n").pop() };
  const { looks, totals } = JSON.parse(r.stdout);
  const kept = [];
  for (const l of looks) {
    for (const d of l.dets) {
      if (d.confidence >= 0.5) kept.push({ cameraId: "cam-1", atUtc: new Date(T0 + l.t).toISOString(), ...d });
    }
  }
  const events = foldDetections(kept).filter((e) => e.kind === "person");
  return { events: events.length, looked: totals.looked, frames: totals.frames, weak: looks.length - kept.length };
}
const on = foldScenario("on");
const off = foldScenario("off");
if (on.error || off.error) {
  results.push({ ok: false, name: `the fold scenario did not run: ${on.error ?? off.error}` });
} else {
  results.push({
    ok: off.events >= 2,
    name: `without local motion the slow drifter splits (${off.events} events from ${off.looked} looks), so the scenario is the failure feared`,
  });
  results.push({
    ok: on.events === 1 && on.weak === 1,
    name: `THE SLOW DRIFTER THROUGH THE REAL FOLD: gated as built, with one look under the floor, it is ONE event (${on.events} from ${on.looked} of ${on.frames} frames)`,
  });
}

console.log("motion gate against the fold");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`motion gate against the fold: ${results.length - failed} passed, ${failed} failed`);
process.exit(tests.status === 0 && failed === 0 ? 0 : 1);
