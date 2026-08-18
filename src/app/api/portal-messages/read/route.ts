import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office marks all unread CLIENT messages in a customer's thread as read
// (read_at = now). Office-only: the unread count is an office-side inbox
// concept. RLS restricts the update to same-org (tier_office_or_pm FOR UPDATE
// WITH CHECK), so a cross-org customerId updates zero rows (harmless). Idempotent
// — re-marking an already-read thread is a no-op.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role ?? "crew";
  if (!OFFICE_OR_PM.has(role as never)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { customerId } = body as { customerId?: string };
  if (!customerId) {
    return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("portal_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("customer_id", customerId)
    .eq("sender", "client")
    .is("read_at", null)
    .select("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, marked: data?.length ?? 0 });
}