import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";
import { captureException } from "@/lib/sentry";

// Nightly settlement backstop.
//
// A visit that passed gates 1-3 (the crew left, stayed gone past the grace
// period, and were on site long enough to be real work) is moved into the
// office approval queue by stamping awaiting_approval_since.
//
// THIS ROUTE NEVER EMAILS A CUSTOMER, and that is deliberate rather than a
// limitation. It is the unattended path — it runs at 05:47 with nobody
// watching, for visits whose crew phone died, lost signal, or force-quit
// without flushing. The right behaviour when we are least sure what happened is
// to put the visit in front of a human, not to mail a homeowner in the middle
// of the night.
//
// The primary settlement path is the crew pressing End shift, where a real
// session exists and the ordinary /api/lawn/visits/[id]/status route does the
// completing and the emailing. One email path, always: duplicating the
// notification block here would be a second copy of ~200 lines that sends
// service_complete, mints the review request and stamps notified_at, and the
// two would drift.
//
// Secured by CRON_SECRET exactly like every other platform cron.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 401 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One shared database, two Vercel deploys scheduling the same vercel.json.
  // The construction deploy is the established cron owner; the lawn deploy's
  // scheduled invocation no-ops here so this cannot run twice.
  if (isLawn()) {
    return NextResponse.json({ ok: true, skipped: "construction owns cron" });
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
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

  try {
    // Gates 1-3 live in SQL so this route and the client agree by construction.
    const { data, error } = await admin.rpc("settleable_visits");
    if (error) {
      captureException(
        error instanceof Error ? error : new Error(String(error)),
        { extra: { route: "cron/settle", stage: "settleable_visits" } }
      );
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as {
      visit_id: string;
      organization_id: string;
      completion_mode: string;
      already_queued: boolean;
    }[];

    // Already queued means a human has it; re-stamping would only reorder the
    // queue and make it look newer than it is.
    const toQueue = rows.filter((r) => !r.already_queued).map((r) => r.visit_id);
    if (toQueue.length === 0) {
      return NextResponse.json({ ok: true, examined: rows.length, queued: 0 });
    }

    const { error: upErr } = await admin
      .from("lawn_visits")
      .update({ awaiting_approval_since: new Date().toISOString() })
      .in("id", toQueue);
    if (upErr) {
      captureException(
        upErr instanceof Error ? upErr : new Error(String(upErr)),
        { extra: { route: "cron/settle", stage: "queue", count: toQueue.length } }
      );
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      examined: rows.length,
      queued: toQueue.length,
      // Reported so a mode that never completes unattended is visible in the
      // logs rather than silently surprising someone later.
      auto_mode_awaiting_end_shift: rows.filter(
        (r) => !r.already_queued && r.completion_mode === "auto"
      ).length,
    });
  } catch (e) {
    captureException(
      e instanceof Error ? e : new Error(String(e)),
      { extra: { route: "cron/settle", stage: "sweep" } }
    );
    return NextResponse.json({ error: "Settlement sweep failed" }, { status: 500 });
  }
}
