#!/usr/bin/env node
// Revoke every live session for the two E2E test accounts.
//
// WHY: their password was hardcoded in eight harnesses and sat in a PUBLIC repo
// from 2026-09-05. Rotating a password in Supabase does NOT revoke sessions that
// already exist — each refresh token keeps working on its own. So rotation
// alone is cosmetic against anyone already holding one, and this has to run too.
//
// At the time of writing there were 143 live sessions on the admin account and
// 26 on the crew account, accumulated because the harnesses sign in and never
// sign out.
//
// SCOPE GUARD: this will only ever touch the two accounts named below, and only
// after confirming each one belongs to the test org. It refuses anything else,
// because a script that revokes sessions is one typo away from signing out a
// real customer.
//
// Usage — identical in PowerShell, cmd and bash:
//
//   node scripts/revoke-e2e-sessions.mjs
//       Dry run. Reports what it found; changes nothing.
//
//   node scripts/revoke-e2e-sessions.mjs --confirm --rotate
//       Sets a NEW generated password on both accounts and prints it once.
//       Copy that into .env.local as E2E_PASSWORD.
//
// To choose the password yourself, set E2E_NEW_PASSWORD first. In PowerShell
// that is  $env:E2E_NEW_PASSWORD='...'  on its own line — the bash-style
// VAR=x node script  prefix does NOT work there, which is exactly why the
// generated default exists.

import fs from "node:fs";
import { randomBytes } from "node:crypto";

// Hardcoded on purpose. Taking these as arguments is how you accidentally sign
// out a live customer.
const TARGETS = ["e2e-admin-lawn@test.local", "e2e-crew-lawn@test.local"];
const TEST_ORG = "600d02fa-fae2-440b-99ab-42e96997da91"; // Terra Verde Test Co

const CONFIRM = process.argv.includes("--confirm");
const ROTATE = process.argv.includes("--rotate");

// GENERATED HERE BY DEFAULT, rather than asked for.
//
// The earlier version required E2E_NEW_PASSWORD in the environment, which is
// bash syntax — `VAR=x node script` is not a thing in PowerShell, so the
// documented command silently did nothing useful on the machine this runs on.
// Generating it removes the step entirely: one command, and the value is
// printed once for pasting into .env.local.
//
// Still overridable for anyone who wants to choose their own.
const NEW_PASSWORD =
  process.env.E2E_NEW_PASSWORD || `E2e-${randomBytes(15).toString("base64url")}`;
const GENERATED = !process.env.E2E_NEW_PASSWORD;

function loadEnv() {
  let text;
  try {
    text = fs.readFileSync(".env.local", "utf8");
  } catch {
    console.error("Could not read .env.local — run this from the repo root.");
    process.exit(1);
  }
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

const env = loadEnv();
const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !SERVICE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local.");
  process.exit(1);
}
// No check needed for a missing password any more — one is generated above.

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** Find one user by email via the admin API. Returns null when absent. */
async function findUser(email) {
  const r = await fetch(
    `${URL_BASE}/auth/v1/admin/users?page=1&per_page=200`,
    { headers }
  );
  if (!r.ok) throw new Error(`admin list users: ${r.status} ${await r.text()}`);
  const body = await r.json();
  const users = body.users ?? body ?? [];
  return users.find((u) => (u.email || "").toLowerCase() === email.toLowerCase()) ?? null;
}

/** The org a profile belongs to — the scope guard's evidence. */
async function orgOf(userId) {
  const r = await fetch(
    `${URL_BASE}/rest/v1/profiles?id=eq.${userId}&select=organization_id,role`,
    { headers }
  );
  if (!r.ok) throw new Error(`profiles read: ${r.status}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

// THE ADMIN LOGOUT ROUTE DOES NOT EXIST ON THIS PROJECT. The obvious call —
// POST /auth/v1/admin/users/{id}/logout — returns 404; that endpoint is not
// exposed by the GoTrue version behind this project, and finding out cost a
// failed run. There is no REST route that revokes another user's sessions here
// and no generic SQL-over-REST either, so the revocation itself is two DELETEs
// against the database. This script's job is to make those SAFE: resolve the
// accounts, PROVE they are in the test org, and print the exact scoped SQL —
// rather than pretending to revoke and silently failing, which is what the
// first version did.
//
// Password rotation is different: that admin route does work, so --rotate is
// carried out directly below.
function revocationSql(ids) {
  const list = ids.map((i) => `'${i}'`).join(", ");
  return [
    "-- Scoped to these account IDs only. Never widen this to a LIKE pattern.",
    `with targets as (select id from auth.users where id in (${list})),`,
    "del_rt as (delete from auth.refresh_tokens",
    "           where user_id::text in (select id::text from targets) returning 1),",
    "del_s  as (delete from auth.sessions",
    "           where user_id in (select id from targets) returning 1)",
    "select (select count(*) from del_rt) as refresh_tokens_deleted,",
    "       (select count(*) from del_s)  as sessions_deleted;",
  ].join("\n");
}

async function rotate(userId) {
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ password: NEW_PASSWORD }),
  });
  if (!r.ok) throw new Error(`password update: ${r.status} ${await r.text()}`);
}

console.log(CONFIRM ? "REVOKING SESSIONS\n" : "DRY RUN — nothing will change. Add --confirm to act.\n");

let failures = 0;
const verified = [];
for (const email of TARGETS) {
  try {
    const user = await findUser(email);
    if (!user) {
      console.log(`  ${email}\n    not found — nothing to do`);
      continue;
    }
    const profile = await orgOf(user.id);

    // THE GUARD. If this account is not in the test org, something is wrong with
    // the assumptions in this script and it must not act.
    if (!profile || profile.organization_id !== TEST_ORG) {
      console.error(
        `  ${email}\n    REFUSING — org is ${profile?.organization_id ?? "unknown"}, not the test org.`
      );
      failures += 1;
      continue;
    }

    console.log(`  ${email}`);
    console.log(`    id:   ${user.id}`);
    console.log(`    role: ${profile.role}   org: test org (verified)`);
    console.log(`    last sign-in: ${user.last_sign_in_at ?? "never"}`);

    verified.push(user.id);

    if (CONFIRM && ROTATE) {
      await rotate(user.id);
      console.log("    password rotated");
    }
  } catch (err) {
    console.error(`  ${email}\n    FAILED: ${err.message}`);
    failures += 1;
  }
}

if (verified.length) {
  console.log([
    "",
    "Run this against the database to revoke the sessions:",
    "",
    revocationSql(verified),
    "",
    "Then confirm both are at zero:",
    "  select u.email, (select count(*) from auth.sessions s where s.user_id = u.id) as sessions",
    `  from auth.users u where u.email in ('${TARGETS.join("','")}');`,
  ].join("\n"));
}
if (!CONFIRM) {
  console.log("\nDry run. Re-run with --confirm (add --rotate to set a new password).");
}
if (ROTATE && CONFIRM && !failures) {
  // Printed ONCE, and nowhere else. Not written to a file, not logged, not
  // committed — putting it somewhere automatically is how it ended up in a
  // public repo the first time.
  console.log(
    [
      "",
      "=".repeat(62),
      GENERATED ? "  NEW PASSWORD (generated just now):" : "  NEW PASSWORD (the one you supplied):",
      "",
      `      ${NEW_PASSWORD}`,
      "",
      "  Copy this into .env.local in every checkout you run harnesses from:",
      "",
      `      E2E_PASSWORD=${NEW_PASSWORD}`,
      "",
      "  .env.local is gitignored, so it never reaches the repo. This is the",
      "  only time this value is shown.",
      "=".repeat(62),
    ].join("\n")
  );
}
process.exit(failures ? 1 : 0);
