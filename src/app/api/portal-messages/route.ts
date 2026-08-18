import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOfficeLike, OFFICE_OR_PM } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Bidirectional Client Portal message thread between a customer and the office,
// backed by the portal_messages table. RLS does the heavy lifting (see
// portal_messages.sql):
//   - customer sees/inserts only their own customer_id rows (sender pinned to
//     'client' on insert);
//   - office (OFFICE_OR_PM) sees/inserts any same-org customer's rows (sender
//     pinned to 'office' on insert).
// The set_org_from_customer BEFORE-INSERT trigger stamps organization_id from
// the customer, so the client never has to supply (or know) it.
//
// GET  ?customerId=<id>  — newest-first thread for that customer (office: any
//                         same-org; customer: must be their own).
// POST { customerId, body } — append a message. Sender is inferred from the
//                             caller's role (customer → 'client', office →
//                             'office'). RLS WITH CHECK enforces the pin.

async function resolveCaller(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, customer_id, organization_id")
    .eq("id", user.id)
    .maybeSingle();
  return { user, profile };
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const caller = await resolveCaller(supabase);
  if (!caller) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { profile } = caller;
  const role = profile?.role ?? "crew";

  const { searchParams } = new URL(request.url);
  const customerId = searchParams.get("customerId");
  if (!customerId) {
    return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
  }

  // Customer may only read their own thread; office/PM may read any same-org
  // customer's (RLS enforces same-org + the customer-own filter). A customer
  // asking for someone else's customerId gets an empty list (RLS returns none),
  // which is safe — but we short-circuit to be explicit.
  if (!isOfficeLike(role) && !OFFICE_OR_PM.has(role as never)) {
    if (role !== "customer" || profile?.customer_id !== customerId) {
      return NextResponse.json({ messages: [] });
    }
  }

  const { data, error } = await supabase
    .from("portal_messages")
    .select("id, sender, body, created_at, read_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ messages: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const caller = await resolveCaller(supabase);
  if (!caller) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { profile } = caller;
  const role = profile?.role ?? "crew";

  const body = await request.json().catch(() => ({}));
  const { customerId, body: text } = body as { customerId?: string; body?: string };
  if (!customerId || !text || !text.trim()) {
    return NextResponse.json({ error: "Missing customerId or body" }, { status: 400 });
  }

  // Sender is inferred from role — the client cannot claim 'office', and the
  // office cannot claim 'client' (RLS WITH CHECK would reject either anyway).
  const isOffice = OFFICE_OR_PM.has(role as never);
  const sender = isOffice ? "office" : "client";

  if (!isOffice) {
    // Customer: must be posting to their own thread.
    if (role !== "customer" || profile?.customer_id !== customerId) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
  }
  // Office: any same-org customer (RLS tier_office_or_pm enforces same-org on
  // insert; a cross-org customerId is rejected by WITH CHECK).

  const { data, error } = await supabase
    .from("portal_messages")
    .insert({
      customer_id: customerId,
      sender,
      body: text.trim().slice(0, 4000),
    })
    .select("id, created_at")
    .single();

  if (error) {
    // RLS rejection (cross-org / wrong sender) surfaces as a 42501/23514 etc.
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  return NextResponse.json({ ok: true, id: data.id, createdAt: data.created_at });
}