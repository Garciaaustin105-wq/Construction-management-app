import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import LeadCaptureForm from "./LeadCaptureForm";

export const dynamic = "force-dynamic";

// Public lead-capture form. A logged-out prospect reaches /lead/{lead_form_token}
// (the office shares the link on their site / Google Business Profile). The
// token is the sole credential (mirrors lawn_visits.share_token / the /v
// portal). Resolved via the service role (bypasses RLS) so a logged-out visitor
// can load the form; the form POSTs to /api/leads (also service-role).
//
// Lawn-only for launch: only lawn orgs have a lead_form_token (leads.sql
// backfill + /api/signup), so a construction org / bogus token 404s here. The
// page is variant-neutral (builds on both deploys) — construction just never
// has a valid token to reach a real form.

export default async function PublicLeadFormPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false }
    }
  );

  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name, app_variant, email")
    .eq("lead_form_token", token)
    .maybeSingle();
  const org = orgRow as unknown as {
    id: string;
    name: string | null;
    app_variant: string | null;
    email: string | null;
  } | null;
  // No token, or the org isn't lawn-enabled → 404 (no form for construction).
  if (!org || org.app_variant !== "lawn") notFound();

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-5" style={{ background: "#15803d" }}>
            <p className="text-white text-lg font-bold tracking-tight">
              {org.name ?? "Our lawn service"}
            </p>
            <p className="text-green-100 text-xs uppercase tracking-wider mt-0.5">
              Request a quote
            </p>
          </div>
          <div className="p-6">
            <p className="text-sm text-gray-600 leading-relaxed mb-5">
              Tell us about your property and what you need — we&apos;ll get back
              to you with a quote.
            </p>
            <LeadCaptureForm token={token} orgName={org.name ?? "our team"} />
          </div>
        </div>
        {org.email && (
          <p className="text-center text-[11px] text-gray-400 mt-4">
            Questions? Contact {org.name ?? "us"} at {org.email}.
          </p>
        )}
      </div>
    </div>
  );
}