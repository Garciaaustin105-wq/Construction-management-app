import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isLawn } from "@/lib/variant";

// Daily compliance reminders (handoff doc 04 items 5 + 13). Two sweeps, both
// best-effort notification inserts deduped by the notifications unique index
// on (type, entity_id) — a crew or record only ever notifies once:
//
//   A. Expiring applicator licenses — crew_members.applicator_license_expires
//      within the next 14 days (or already past). Without this the first sign
//      of a lapsed license is a blocked chemical application in the field.
//   B. Unshared restricted-use application records — RUP applications older
//      than 25 days with no shared_at (the 30-day customer record-copy rule
//      (federal) gives limited runway; the office needs a nudge to send it).
//
// Same deployment contract as every platform cron: CRON_SECRET bearer auth,
// the construction-deploy ownership gate (one DB, two deploys), service role,
// 60s ceiling.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LICENSE_WINDOW_DAYS = 14;
const RUP_SHARE_GRACE_DAYS = 25;

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoTimestampOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

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

  // ── A. Expiring licenses ────────────────────────────────────────────────
  // Includes already-expired (lower bound in the past) so a license that was
  // never renewed keeps nagging instead of going quiet after the date passes.
  const windowEnd = isoDateOffset(LICENSE_WINDOW_DAYS);
  const { data: expiring, error: licErr } = await admin
    .from("crew_members")
    .select("id, organization_id, name, applicator_license_number, applicator_license_expires")
    .not("applicator_license_expires", "is", null)
    .lte("applicator_license_expires", windowEnd)
    .limit(500);

  let licensesNotified = 0;
  if (!licErr && expiring?.length) {
    const rows = expiring.map((c) => {
      const expires = c.applicator_license_expires as string;
      const expired = expires < isoDateOffset(0);
      return {
        organization_id: c.organization_id,
        type: "license_expiring",
        title: expired ? "Applicator license EXPIRED" : "Applicator license expiring",
        body: [
          c.name,
          c.applicator_license_number ? `# ${c.applicator_license_number}` : null,
          expired ? `expired ${expires}` : `expires ${expires}`,
        ]
          .filter(Boolean)
          .join(" · "),
        href: "/admin/crew-members",
        entity_id: c.id,
      };
    });
    // Unique (type, entity_id) index makes this idempotent across daily runs.
    const { error: insErr } = await admin
      .from("notifications")
      .upsert(rows, { onConflict: "type,entity_id", ignoreDuplicates: true });
    if (!insErr) licensesNotified = rows.length;
    else return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // ── B. Unshared RUP application records ─────────────────────────────────
  // chemical_applications has NO FK to chemical_products (no PostgREST embed),
  // so resolve restricted product ids first and filter with .in().
  const { data: rupProducts, error: prodErr } = await admin
    .from("chemical_products")
    .select("id")
    .eq("is_restricted_use", true)
    .limit(1000);

  let rupNotified = 0;
  if (prodErr) {
    return NextResponse.json({ error: prodErr.message }, { status: 500 });
  }
  if (rupProducts?.length) {
    const graceCutoff = isoTimestampOffset(RUP_SHARE_GRACE_DAYS);
    const { data: unshared, error: rupErr } = await admin
      .from("chemical_applications")
      .select("id, organization_id")
      .is("shared_at", null)
      .lt("created_at", graceCutoff)
      .in(
        "product_id",
        rupProducts.map((p) => p.id)
      )
      .limit(500);

    if (rupErr) {
      return NextResponse.json({ error: rupErr.message }, { status: 500 });
    }
    if (unshared?.length) {
      const rows = unshared.map((a) => ({
        organization_id: a.organization_id,
        type: "rup_record_unshared",
        title: "RUP record not shared with customer",
        body: "A restricted-use application is past 25 days without a customer record copy (30-day rule).",
        href: "/lawn/applications",
        entity_id: a.id,
      }));
      const { error: insErr } = await admin
        .from("notifications")
        .upsert(rows, { onConflict: "type,entity_id", ignoreDuplicates: true });
      if (!insErr) rupNotified = rows.length;
      else return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    licensesFlagged: licensesNotified,
    rupRecordsFlagged: rupNotified,
  });
}