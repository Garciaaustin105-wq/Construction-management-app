import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { inviteClientToPortal } from "@/lib/portalInvite";
import { OFFICE_OR_PM, type Role } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Office "Send as Proposal" — the authed-only proposal send. Unlike the regular
// estimate Send (which emails a frictionless /q/{token} public link), a proposal
// requires the customer to be a portal user who signs in + e-signs. So this =
// ensure the customer is invited to the Client Portal (auto-invite if not) +
// email them a magic-link sign-in, then mark the estimate 'sent'. No share_token
// is minted (no public path). The customer signs in → /customer → Review & Sign.
//
// Auth split (mirrors /api/clients/invite + /api/invoices/[id]/send): RLS session
// client for the auth check + the scoped estimate/customer read; service-role
// admin for the invite writes (generateLink + profiles) + the status flip.

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  if (!me.hasProfile) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const role = me.role as Role | null;
  if (!role || !OFFICE_OR_PM.has(role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const orgId = me.orgId;
  if (!orgId) {
    return NextResponse.json({ error: "No organization" }, { status: 403 });
  }

  // RLS-scoped read: only a same-org estimate the office can see comes back.
  const { data: estimate } = await supabase
    .from("estimates")
    .select(
      "id, status, customer_id, requires_signature, customers(name, contact_email)"
    )
    .eq("id", id)
    .maybeSingle();
  if (!estimate) {
    return NextResponse.json({ error: "Estimate not found" }, { status: 404 });
  }
  if (!estimate.requires_signature) {
    return NextResponse.json(
      { error: "This estimate is not set up as a proposal (enable 'Require signature')." },
      { status: 400 }
    );
  }
  if (!estimate.customer_id) {
    return NextResponse.json(
      { error: "Link a customer to this estimate before sending." },
      { status: 400 }
    );
  }
  if (estimate.status !== "draft" && estimate.status !== "sent") {
    return NextResponse.json(
      { error: "This estimate has already been decided and can't be re-sent." },
      { status: 400 }
    );
  }

  const customer = estimate.customers as unknown as
    | { name: string | null; contact_email: string | null }
    | null;
  if (!customer?.contact_email?.trim()) {
    return NextResponse.json(
      { error: "This customer has no contact email on file. Add one in Customers first." },
      { status: 400 }
    );
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();
  const orgName = (org?.name as string | null)?.trim() || "your contractor";

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const origin = requestOrigin(request);

  // Auto-invite (or resend) the customer to the Client Portal + email the magic
  // link. Reuses the same path as /api/clients/invite.
  const result = await inviteClientToPortal(
    admin,
    {
      id: estimate.customer_id,
      name: customer.name,
      contact_email: customer.contact_email,
    },
    orgId,
    orgName,
    origin
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Failed to invite customer" },
      { status: 500 }
    );
  }

  // Mark the estimate sent (no share_token — authed-only, no public link).
  const now = new Date().toISOString();
  const { error: sendError } = await admin
    .from("estimates")
    .update({ status: "sent", sent_at: now, updated_at: now })
    .eq("id", id);
  if (sendError) {
    return NextResponse.json(
      { error: `Customer invited, but marking sent failed: ${sendError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    sentVia: result.sentVia,
    emailed: result.sentVia !== "none",
  });
}