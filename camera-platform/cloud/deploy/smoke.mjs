// cloud/deploy/smoke.mjs — a read-only, no-side-effects check against a
// LIVE deployed stack (CLOUD-AWS-SPEC.md section C). Run by hand after
// deploy.ps1 prints its ApiUrl.
//
// Only requests that read or get refused. It never creates a user or a
// device, never claims a code, never logs anyone in:
//   - GET /fleet with no cookie     -> 401 (no session, refused)
//   - POST /login, an unknown login -> 401 (refused; still one scrypt run
//     server-side, so this is a normal login attempt, not free)
//   - GET /nope                     -> 404 (API Gateway's own: no catch-all route, the function never runs)
//
// Usage: node cloud/deploy/smoke.mjs <apiUrl>
//   e.g. node cloud/deploy/smoke.mjs https://abc123.execute-api.us-east-1.amazonaws.com

const apiUrl = process.argv[2];
if (!apiUrl) {
  console.error("usage: node cloud/deploy/smoke.mjs <apiUrl>");
  process.exit(1);
}
const base = apiUrl.replace(/\/+$/, "");

/**
 * @param {string} name
 * @param {() => Promise<number>} fn  returns the actual HTTP status
 * @param {number} expected
 */
async function check(name, fn, expected) {
  let actual;
  let note = "";
  try {
    actual = await fn();
  } catch (err) {
    console.log(`  FAIL ${name}: request threw: ${err.message}`);
    return false;
  }
  const ok = actual === expected;
  if (!ok) note = ` (expected ${expected})`;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: got ${actual}${note}`);
  return ok;
}

let allOk = true;

allOk =
  (await check(
    "GET /fleet with no cookie -> 401",
    async () => (await fetch(`${base}/fleet`, { method: "GET" })).status,
    401,
  )) && allOk;

allOk =
  (await check(
    "POST /login, an unknown login -> 401",
    async () =>
      (
        await fetch(`${base}/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login: "nobody@example.com", password: "wrong password here" }),
        })
      ).status,
    401,
  )) && allOk;

allOk =
  (await check(
    "GET /nope -> 404",
    async () => (await fetch(`${base}/nope`, { method: "GET" })).status,
    404,
  )) && allOk;

console.log(allOk ? "\nsmoke: ALL PASSED" : "\nsmoke: FAILED");
process.exit(allOk ? 0 : 1);
