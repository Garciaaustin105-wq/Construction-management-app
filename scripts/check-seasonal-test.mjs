// Throwaway auto-resume verify probe. Loads .env.local (service role) and
// prints the test schedule's state + recent visits — NO secrets echoed.
// Usage:  node scripts/check-seasonal-test.mjs
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envPath = new URL("../.env.local", import.meta.url);
if (!existsSync(envPath)) {
  console.error("no .env.local found");
  process.exit(1);
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
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const TEST_ID = "a7d6efe8-c708-4bdd-ac8d-0dce84d6da20";
const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: sched, error: se } = await admin
  .from("recurring_schedules")
  .select("id, active, paused_from, paused_until, service_type")
  .eq("id", TEST_ID)
  .maybeSingle();
if (se) {
  console.error("schedule query error:", se.message);
  process.exit(1);
}
console.log("=== schedule ===");
console.log(JSON.stringify(sched, null, 2));

const { data: visits, error: ve } = await admin
  .from("lawn_visits")
  .select("due_date, status")
  .eq("recurring_schedule_id", TEST_ID)
  .order("due_date", { ascending: false })
  .limit(8);
if (ve) {
  console.error("visits query error:", ve.message);
  process.exit(1);
}
console.log("=== recent visits (newest first) ===");
console.log(JSON.stringify(visits, null, 2));

const today = new Date().toISOString().slice(0, 10);
const pendingFromToday = (visits ?? []).filter(
  (v) => v.due_date >= today && v.status === "pending"
).length;
console.log(`\npending visits from ${today} forward: ${pendingFromToday}`);
console.log(
  sched?.active
    ? "PASS: schedule reactivated"
    : "FAIL: schedule still inactive — cron may not have run the auto-resume step (old deploy?)"
);