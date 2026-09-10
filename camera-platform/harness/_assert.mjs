let passed = 0;
const failures = [];

export function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

export function eq(actual, expected, what = "value") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

export function close(actual, expected, tolerance, what = "value") {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${what}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

export function throws(fn, what = "call") {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(`${what}: expected it to throw, it did not`);
}

export function report(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
  return failures.length;
}
