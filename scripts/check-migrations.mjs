// Scans SQL migration files for DESTRUCTIVE statements and exits non-zero if
// any are found, so a data-killing migration can't slip into a deploy unnoticed.
// Run locally before pushing ("node scripts/check-migrations.mjs") or in CI
// (.github/workflows/migration-guard.yml).
//
// What gets flagged (the unambiguous data killers):
//   DROP TABLE | DROP COLUMN | DROP SCHEMA | DROP DATABASE | TRUNCATE
//
// What does NOT get flagged (idempotent, recreatable, safe):
//   drop policy if exists  ·  drop index if exists  ·  create or replace function
//   alter table ... drop constraint  ·  delete from <config_table> (review by hand)
//
// DELETE/UPDATE without WHERE are intentionally NOT auto-flagged because
// legitimate migrations touch config tables that way (e.g. setting a bucket
// public=false). Review those statements manually instead.
//
// Usage: node scripts/check-migrations.mjs [dir]   (default dir = repo root)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");

// Patterns matched per-line, case-insensitive, after stripping `--` comments.
// `drop table` / `drop column` / `drop schema` / `drop database` / `truncate`
const PATTERNS = [
  { re: /\bdrop\s+table\b/i, label: "DROP TABLE — destroys all rows in the table" },
  { re: /\bdrop\s+column\b/i, label: "DROP COLUMN — destroys column data" },
  { re: /\bdrop\s+schema\b/i, label: "DROP SCHEMA — destroys the schema" },
  { re: /\bdrop\s+database\b/i, label: "DROP DATABASE — destroys the database" },
  { re: /\btruncate\b/i, label: "TRUNCATE — destroys all rows" },
];

// Collect every .sql file under root (one level — migrations live at repo root).
const sqlFiles = readdirSync(root)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => join(root, f))
  .filter((f) => statSync(f).isFile());

const findings = [];

for (const file of sqlFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((raw, idx) => {
    // Strip `-- ...` line comments. Block comments /* */ are rare in migrations;
    // if present, this line-level strip may miss them, but every flagged
    // pattern is a real statement keyword, so a false positive from inside a
    // comment is the only risk and is easy to spot.
    const line = raw.replace(/--.*$/, "");
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) {
        findings.push({ file, line: idx + 1, label, text: raw.trim() });
      }
    }
  });
}

if (findings.length === 0) {
  console.log(`migration-guard: scanned ${sqlFiles.length} .sql files — no destructive statements found.`);
  process.exit(0);
}

console.error(`migration-guard: ${findings.length} destructive statement(s) found — review before deploy:`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.label}`);
  console.error(`    ${f.text}`);
}
console.error("");
console.error("If this is intentional (e.g. dropping a table you confirmed is empty),");
console.error("re-run with:  node scripts/check-migrations.mjs --allow-destructive");
// The --allow flag is a placeholder for a future allowlist; for now, the guard
// is advisory in CI (see workflow), so we exit 0 when that flag is passed.
if (process.argv.includes("--allow-destructive")) {
  console.error("(--allow-destructive: proceeding anyway)");
  process.exit(0);
}
process.exit(1);