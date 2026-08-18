import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { sendClientPortalMagicLink } from "@/lib/email";
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
  if (!profile || !isOfficeLike(profile.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const orgId = profile.organization_id as string | null;
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
  const redirectTo = `${origin}/auth/callback?flow=client`;

  // 1. Create (or refresh) the auth user + mint a magic-link action_link.
  //    generateLink({type:'magiclink'}) creates the user if absent; on resend it
  //    returns a fresh link for the existing user. We stamp user_metadata so the
  //    callback / profile knows this is a customer tied to this customer_id.
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo,
        data: {
          role: "customer",
          full_name: customer.name ?? "",
          customer_id: customer.id,
          organization_id: orgId,
        },
      },
    });
  if (linkError || !linkData.user || !linkData.properties?.action_link) {
    return NextResponse.json(
      { error: linkError?.message ?? "Failed to create sign-in link" },
      { status: 500 }
    );
  }
  const userId = linkData.user.id;
  const signInLink = linkData.properties.action_link;

  // 2. Idempotently upsert the profiles row (id = auth user id). On conflict
  //    (resend for an already-invited customer) keep customer_id/organization_id
  //    pinned (a customer profile must never drift to another customer). For a
  //    brand-new invite this is an insert.
  const { error: profileError } = await admin.from("profiles").upsert(
    {
      id: userId,
      email,
      full_name: customer.name ?? "",
      role: "customer",
      customer_id: customer.id,
      organization_id: orgId,
    },
    { onConflict: "id" }
  );
  if (profileError) {
    return NextResponse.json(
      { error: `Profile write failed: ${profileError.message}` },
      { status: 500 }
    );
  }

  // 3. Deliver the magic link. NON-FATAL: prefer branded Resend; fall back to
  //    Supabase's built-in magic-link email if Resend is unconfigured or rejects
  //    (same strategy as /api/signup). The portal row + profile are already
  //    created, so a delivery failure is a warning, not a rollback.
  let sentVia: "resend" | "supabase" | "none" = "none";
  const resendReady = !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
  let useSupabaseFallback = !resendReady;
  if (resendReady) {
    try {
      const result = await sendClientPortalMagicLink({
        to: email,
        clientName: customer.name ?? "",
        orgName,
        signInLink,
      });
      if (result.error) {
        useSupabaseFallback = true;
      } else {
        sentVia = "resend";
      }
    } catch {
      useSupabaseFallback = true;
    }
  }
  if (useSupabaseFallback) {
    try {
      const anon = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      const { error: otpError } = await anon.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (otpError) {
        sentVia = "none";
      } else {
        sentVia = "supabase";
      }
    } catch {
      sentVia = "none";
    }
  }

  return NextResponse.json({
    ok: true,
    invited: true,
    sentVia,
    emailed: sentVia !== "none",
  });
}