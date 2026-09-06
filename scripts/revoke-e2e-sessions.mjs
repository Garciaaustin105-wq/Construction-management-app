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
// Usage:
//   node scripts/revoke-e2e-sessions.mjs              # dry run — reports, changes nothing
//   node scripts/revoke-e2e-sessions.mjs --confirm    # actually revokes
//
// Optional password rotation in the same pass. The value comes from YOUR
// environment; it is never written to disk or logged:
//   E2E_NEW_PASSWORD='...' node scripts/revoke-e2e-sessions.mjs --confirm --rotate
//
// Afterwards, put the new password in .env.local (gitignored) as E2E_PASSWORD so
// the harnesses keep working.

import fs from "node:fs";

// Hardcoded on purpose. Taking these as arguments is how you accidentally sign
// out a live customer.
const TARGETS = ["e2e-admin-lawn@test.local", "e2e-crew-lawn@test.local"];
const TEST_ORG = "600d02fa-fae2-440b-99ab-42e96997da91"; // Terra Verde Test Co

const CONFIRM = process.argv.includes("--confirm");
const ROTATE = process.argv.includes("--rotate");
const NEW_PASSWORD = process.env.E2E_NEW_PASSWORD || "";

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
if (ROTATE && !NEW_PASSWORD) {
  console.error("--rotate needs E2E_NEW_PASSWORD in the environment.");
  process.exit(1);
}

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

async function revoke(userId) {
  // GoTrue admin logout: invalidates every refresh token for the user.
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${userId}/logout`, {
    method: "POST",
    headers,
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`logout: ${r.status} ${await r.text()}`);
  }
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

    if (!CONFIRM) {
      console.log(`    would revoke all sessions${ROTATE ? " and set a new password" : ""}`);
      continue;
    }

    await revoke(user.id);
    console.log("    sessions revoked");
    if (ROTATE) {
      await rotate(user.id);
      console.log("    password rotated");
    }
  } catch (err) {
    console.error(`  ${email}\n    FAILED: ${err.message}`);
    failures += 1;
  }
}

console.log(
  CONFIRM
    ? "\nDone. Verify with:  select count(*) from auth.sessions s join auth.users u on u.id=s.user_id where u.email like 'e2e-%@test.local';"
    : "\nDry run complete. Re-run with --confirm to revoke."
);
if (ROTATE && CONFIRM) {
  console.log("Now put the new password in .env.local as E2E_PASSWORD so the harnesses keep working.");
}
process.exit(failures ? 1 : 0);
