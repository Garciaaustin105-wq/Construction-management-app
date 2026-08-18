// Shared "invite a customer to the Client Portal" logic, extracted from
// /api/clients/invite so the Proposals "Send as Proposal" flow can reuse it
// (a proposal send IS a portal invite + a "you have a proposal to sign" nudge,
// since e-sign is authed-only). Server-only; the caller passes the service-role
// admin client (generateLink + profiles upsert bypass RLS).
//
// What it does: generateLink({type:'magiclink'}) (creates the auth user if
// absent, returns a fresh action_link each call) → upsert the profiles row
// (customer_id + organization_id pinned) → deliver the link, preferring branded
// Resend and falling back to Supabase's built-in magic-link email if Resend is
// unconfigured/rejects (same strategy as /api/signup). The caller is responsible
// for the auth/role gate + the RLS-scoped customer read + confirming the email
// is present before calling.

import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendClientPortalMagicLink } from "@/lib/email";

export type PortalCustomer = {
  id: string;
  name: string | null;
  contact_email: string | null;
};

export type InviteClientResult = {
  ok: boolean;
  sentVia: "resend" | "supabase" | "none";
  error?: string;
};

export async function inviteClientToPortal(
  admin: SupabaseClient,
  customer: PortalCustomer,
  orgId: string,
  orgName: string,
  origin: string
): Promise<InviteClientResult> {
  const email = customer.contact_email?.trim();
  if (!email) {
    return {
      ok: false,
      sentVia: "none",
      error: "This customer has no contact email on file.",
    };
  }

  const redirectTo = `${origin}/auth/callback?flow=client`;

  // 1. Create (or refresh) the auth user + mint a magic-link action_link.
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
    return {
      ok: false,
      sentVia: "none",
      error: linkError?.message ?? "Failed to create sign-in link",
    };
  }
  const userId = linkData.user.id;
  const signInLink = linkData.properties.action_link;

  // 2. Idempotently upsert the profiles row (id = auth user id). Pin
  //    customer_id/organization_id so a customer profile can never drift.
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
    return {
      ok: false,
      sentVia: "none",
      error: `Profile write failed: ${profileError.message}`,
    };
  }

  // 3. Deliver the magic link. NON-FATAL: prefer branded Resend; fall back to
  //    Supabase's built-in magic-link email if Resend is unconfigured/rejects.
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
      sentVia = otpError ? "none" : "supabase";
    } catch {
      sentVia = "none";
    }
  }

  return { ok: true, sentVia };
}