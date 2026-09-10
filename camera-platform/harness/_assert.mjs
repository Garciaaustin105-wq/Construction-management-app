let passed = 0;
const failures = [];

/**
 * Run one check. Returns a promise, so an async check MUST be awaited.
 *
 * This originally called fn() and caught synchronously, which meant an async
 * check resolved to a pending promise, reported "ok" before its assertions ran,
 * and surfaced any rejection later as an unhandled error — with the checks
 * themselves interleaving out of order. Every async check in a suite was
 * passing vacuously. Hence `mustAwait` below.
 */
export function check(name, fn) {
  const succeed = () => {
    passed++;
    console.log(`  ok   ${name}`);
  };
  const fail = (err) => {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(succeed, fail);
    }
    succeed();
    return Promise.resolve();
  } catch (err) {
    fail(err);
    return Promise.resolve();
  }
}

/**
 * Guard against the bug above coming back: fails loudly if an async check was
 * called without await, rather than silently passing.
 */
export function mustAwait(name, fn) {
  const result = check(name, fn);
  if (!result || typeof result.then !== "function") {
    throw new Error(`check("${name}") did not return a promise — the helper is broken`);
  }
  return result;
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
