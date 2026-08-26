import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";

// Daily stale-lead nudge. Finds leads still in `new` after 24h and drops a
// `lead_stale` notification into the office feed so the office is reminded to
// contact them. Mirrors /api/lawn/cron/remind: CRON_SECRET bearer check,
// construction-owns-cron gate (one DB, two deploys — the construction deploy
// owns the shared crons so the lawn deploy no-ops to avoid double-firing),
// service-role (bypasses RLS).
//
// Idempotent: the notifications unique (type, entity_id) index means one
// lead_stale row per lead, so a re-run or a double-fire from both deploys
// (if the gate ever broke) can't create a second row — onConflict ignore.
//
// No prospect drip in phase 1 — this nudges the OFFICE, not the prospect.
// Prospect drip sequences (the paid differentiator) are deferred.

export const dynamic = "force-dynamic";
// Stale-lead nudge iterates every `new` lead older than 24h platform-wide. Bump
// to the Hobby ceiling (60s) for headroom over the default 10s. Raise to 300 on Pro.
export const maxDuration = 60;

const STALE_AFTER_HOURS = 24;

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

  // One shared database, two Vercel deploys: both schedule this cron. The
  // construction deploy is the cron owner; the lawn deploy no-ops to avoid
  // double notifications.
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
  const admin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false }
    }
  );

  const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3600_000).toISOString();

  const { data: staleRows } = await admin
    .from("leads")
    .select("id, organization_id, name")
    .eq("status", "new")
    .lt("created_at", cutoff);
  const stale = (staleRows as unknown as
    | Array<{ id: string; organization_id: string; name: string }>
    | null) ?? [];

  let notified = 0;
  for (const lead of stale) {
    const { error } = await admin
      .from("notifications")
      .upsert(
        {
          organization_id: lead.organization_id,
          type: "lead_stale",
          title: "Lead waiting",
          body: `${lead.name} has been in New for over 24h`,
          entity_id: lead.id,
          href: "/admin/leads",
        },
        { onConflict: "type,entity_id", ignoreDuplicates: true }
      );
    if (!error) notified += 1;
  }

  return NextResponse.json({ ok: true, stale: stale.length, notified });
}