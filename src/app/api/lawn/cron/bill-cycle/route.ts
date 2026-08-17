import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { runCycleBilling } from "@/lib/lawnBilling";
import { isLawn } from "@/lib/variant";

// Monthly cycle billing cron. Same logic as the on-demand office route but runs
// unattended under the service role (RLS bypassed; triggers still fire). CRON_SECRET
// gated — Vercel sends it as a Bearer token; the route 401s until the secret is
// configured (cron no-ops safely until then).

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 401 }
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One shared database, two Vercel deploys: both schedule these crons (same
  // vercel.json), so without a guard the lawn + construction invocations would
  // BOTH bill against the shared DB → double invoices. The construction deploy
  // is the established cron owner (it's where Vercel Cron has been running these
  // against the real data); the lawn deploy's scheduled invocation no-ops here.
  // If cron ownership ever moves to the lawn deploy, flip this gate.
  if (isLawn()) {
    return NextResponse.json({ ok: true, skipped: "construction owns cron" });
  }

  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured (service role missing)" },
      { status: 500 }
    );
  }
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const result = await runCycleBilling(admin);
  return NextResponse.json({ ok: true, ...result });
}