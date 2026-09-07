// Checks the LIVE database against the function-EXECUTE rule in
// docs/deploy-safety.md, and exits non-zero when anything violates it.
//
// Usage:  node scripts/check-function-grants.cjs
// Run it after any migration that creates or replaces a function.
//
// WHY THIS EXISTS. Every `create function` in `public` grants EXECUTE to PUBLIC
// by default, so a new SECURITY DEFINER function is silently anon-callable the
// moment its migration runs. That is how this project's grants regressed from 0
// anon-reachable functions to 15 between 2026-08-25 and 2026-09-05. The rule was
// written up on 2026-09-06 — and broken again on 2026-09-07, inside a day, when
// a migration revoked `seed_org_catalogue(uuid)` and missed its trigger wrapper.
//
// A rule with nothing checking it decays at the speed people forget. This is the
// check.
//
// It contains no query of its own: that lives in the `audit_function_grants()`
// SECURITY DEFINER function, so the allowlist of deliberate exceptions — the
// me_* RLS predicates and the parameterised helpers policies depend on — sits in
// the database beside the thing it describes, with a reason on every entry.
//
// Needs SUPABASE_SERVICE_ROLE_KEY: the audit function is revoked from every
// client role, because it follows the rule it enforces. No secret is printed.
//
// WHY .cjs AND NOT .mjs, alone among scripts/. DeepSource's JavaScript analyzer
// parses .mjs as a classic script, so every top-level `import` is reported as a
// syntax error; the repo excludes .mjs from analysis for that reason. Root-level
// excludes work, but no exclude pattern tried would match a .mjs inside
// scripts/. CommonJS sidesteps the parser problem entirely, which means this
// file gets LINTED rather than ignored — a better outcome than the exclusion it
// was written to work around.
//
// EXIT CODE, not process.exit(). On Windows, calling process.exit() while the
// Supabase client still holds a keep-alive socket aborts the process with a
// libuv assertion and code 127 — on a CLEAN run. A checker whose success looks
// like a crash is worse than no checker, so this sets process.exitCode and lets
// Node close its own handles.
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { createClient } = require("@supabase/supabase-js");

function fail(...lines) {
  for (const l of lines) console.error(l);
  process.exitCode = 1;
}

const envPath = join(__dirname, "..", ".env.local");

async function main() {
  if (!existsSync(envPath)) {
    fail("no .env.local found");
    return;
  }
  const env = Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
      })
  );
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    fail("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    return;
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await admin.rpc("audit_function_grants");

  if (error) {
    // A missing function is a DIFFERENT failure from a clean run and must not
    // be mistaken for one — exiting 0 here would be the check quietly not
    // running at all, which is the exact failure this script exists to prevent
    // elsewhere.
    fail(
      `could not run audit_function_grants(): ${error.message}`,
      "",
      "If the function is missing, the audit_function_grants migration has not",
      "been applied to this project."
    );
    return;
  }

  const findings = data ?? [];
  if (findings.length === 0) {
    console.log("Function grants clean — nothing anon-reachable, unguarded, or unpinned.");
    return;
  }

  const bySeverity = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const f of findings) (bySeverity[f.severity] ??= []).push(f);

  console.error(`${findings.length} function grant problem(s):`);
  console.error("");
  for (const sev of ["HIGH", "MEDIUM", "LOW"]) {
    const rows = bySeverity[sev] ?? [];
    if (rows.length === 0) continue;
    console.error(`  ${sev}`);
    for (const f of rows) {
      console.error(`    ${f.fn}(${f.args})`);
      console.error(`      ${f.problem}`);
    }
    console.error("");
  }
  console.error("The two blocks a migration must end with are in docs/deploy-safety.md");
  console.error("(section 1a). If a finding is a deliberate exception, add it to the");
  console.error("allowlist inside audit_function_grants() WITH ITS REASON — not here.");

  // Only HIGH fails the run. MEDIUM and LOW are reported every time so they
  // cannot rot quietly, but they do not block: an unpinned search_path is worth
  // fixing and is not worth stopping a deploy over.
  if (bySeverity.HIGH.length > 0) process.exitCode = 1;
}

main();
