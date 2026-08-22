import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { inviteClientToPortal } from "@/lib/portalInvite";
import { isOfficeLike } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office invites a customer to the Client Portal (or resends their sign-in
// link). This is the keystone external-user flow: the customer is modeled as an
// auth.users row with role='customer' linked to a customers row via
// profiles.customer_id, authenticated by a Supabase magic-link (no password).
//
// Auth split (mirrors /api/invoices/[id]/send + /api/signup):
//   - RLS session client (createClient) for the auth check + the scoped customer
//     read (so the office can only invite customers their RLS admits).
//   - service-role admin client for the cross-table writes: generateLink (which
//     creates the auth.users row server-side) + the profiles insert.
//
// `generateLink({type:'magiclink'})` creates the auth user if absent (idempotent
// on resend — returns a fresh action_link each call) and returns
// properties.action_link, which we deliver via Resend. If Resend is not
// configured (or rejects) we fall back to Supabase's built-in magic-link email
// (anon signInWithOtp) — the same Resend→Supabase fallback as signup, so an
// unconfigured Resend never silently locks a newly-invited client out.

function requestOrigin(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  const host =
    xfhost ||
    request.headers.get("host") ||
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return "localhost";
      }
    })();
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  if (!me.hasProfile || !isOfficeLike(me.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const orgId = me.orgId;
  if (!orgId) {
    return NextResponse.json({ error: "No organization" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { customerId } = body as { customerId?: string };
  if (!customerId) {
    return NextResponse.json({ error: "Missing customerId" }, { status: 400 });
  }

  // RLS-scoped read: only a customer the office can see comes back. Fetch the
  // org name too (for the email branding + the Resend→Supabase fallback we need
  // not know it, but the email body uses it).
  const [custRes, orgRes] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, contact_email, organization_id")
      .eq("id", customerId)
      .maybeSingle(),
    supabase.from("organizations").select("name").eq("id", orgId).maybeSingle(),
  ]);
  const customer = custRes.data as
    | { id: string; name: string | null; contact_email: string | null; organization_id: string | null }
    | null;
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  const email = customer.contact_email?.trim();
  if (!email) {
    return NextResponse.json(
      { error: "This customer has no contact email on file. Add one before inviting." },
      { status: 400 }
    );
  }
  // Belt-and-suspenders: the RLS-scoped read already enforces same-org, but
  // confirm the customer's org matches the caller's (a misconfigured policy
  // shouldn't let an office invite into another org).
  if (customer.organization_id && customer.organization_id !== orgId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const orgName = (orgRes.data as { name: string | null } | null)?.name?.trim() || "your contractor";

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const origin = requestOrigin(request);

  // Invite (or resend): generateLink + profiles upsert + deliver. Extracted to
  // /lib/portalInvite so the Proposals "Send as Proposal" flow reuses it.
  const result = await inviteClientToPortal(admin, customer, orgId, orgName, origin);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Invite failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    invited: true,
    sentVia: result.sentVia,
    emailed: result.sentVia !== "none",
  });
}