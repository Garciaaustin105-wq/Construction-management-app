import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { isOfficeLike } from "@/lib/roles";
import { getKind } from "@/lib/emailPreview";

export const dynamic = "force-dynamic";

// Save edits to a TEMPLATED email's wording (the 5 lawn visit-lifecycle events)
// back to notification_templates. Fixed-copy kinds are not editable and are
// rejected here. Mirrors the save the lawn-notifications editor does
// (src/app/lawn/notifications/page.tsx saveTemplate): UPDATE subject+body by
// row id. RLS policy "office manage notification templates" (tier_office, FOR
// ALL — customer_notifications.sql) enforces org scope on both the lookup
// SELECT and the UPDATE, so no service-role client is needed.
//
// Body: { event: NotificationEvent, subject?: string, body: string }
// Response: { ok: true } | 4xx/5xx

type SaveBody = { event?: string; subject?: string; body?: string };

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, organization_id")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role ?? null;
  if (!isOfficeLike(role)) {
    return NextResponse.json(
      { error: "Office or admin only" },
      { status: 403 }
    );
  }

  const organizationId = (profile?.organization_id as string | null) ?? null;
  // super_admin has a null org — they have no org templates to save against.
  if (!organizationId) {
    return NextResponse.json(
      { error: "Your account has no organization to save templates for." },
      { status: 400 }
    );
  }

  let body: SaveBody = {};
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const event = typeof body.event === "string" ? body.event : undefined;
  const kind = event ? getKind(event) : undefined;
  if (!kind || !kind.editable) {
    return NextResponse.json(
      { error: "Only templated email kinds can be saved." },
      { status: 400 }
    );
  }
  if (typeof body.body !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }

  // Resolve the org's email-channel template row by the unique key
  // (organization_id, event, channel). Rows are seeded per-org by the
  // seed_notification_templates trigger, so a missing row only happens for
  // edge cases (treated as 404).
  const { data: row } = await supabase
    .from("notification_templates")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("event", event)
    .eq("channel", "email")
    .maybeSingle();
  if (!row) {
    return NextResponse.json(
      { error: "No template row found for this event." },
      { status: 404 }
    );
  }

  // subject: trim, empty -> null (matches the lawn-notifications editor). body
  // is saved as-is.
  const subject =
    (typeof body.subject === "string" ? body.subject : "").trim() || null;
  const { error } = await supabase
    .from("notification_templates")
    .update({ subject, body: body.body })
    .eq("id", (row as { id: string }).id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}