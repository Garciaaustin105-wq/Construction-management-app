import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import ReviewGate from "./ReviewGate";

export const dynamic = "force-dynamic";

// Public review-request rating gate. A PAID lawn org's visit-done notification
// links the customer here at /r/{token} (instead of straight to Google). The
// customer picks 1-5 stars; happy (4-5★) → Google Business Profile, unhappy
// (1-3★) → internal feedback the office sees. A bad experience never becomes a
// public 1★ review.
//
// Resolved via the service role (bypasses RLS) so a logged-out visitor can load
// the page; the gate POSTs to /api/review-feedback (also service-role). The
// `token` is the sole credential (mirrors /lead/{lead_form_token} / the /v
// photo portal). Variant-neutral — resolves by token, not build variant.

export default async function PublicReviewGatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: rrRow } = await admin
    .from("review_requests")
    .select("id, organization_id, customer_id, visit_id, status, created_at")
    .eq("token", token)
    .maybeSingle();
  const rr = rrRow as unknown as {
    id: string;
    organization_id: string;
    customer_id: string | null;
    visit_id: string | null;
    status: string;
    created_at: string;
  } | null;
  if (!rr) notFound();

  // One-shot open stamp: the first time a `sent` request is opened, mark it
  // opened (so the office can see the request was at least viewed). Idempotent —
  // re-visits on an already-opened/answered row don't touch it.
  if (rr.status === "sent") {
    await admin
      .from("review_requests")
      .update({ status: "opened", opened_at: new Date().toISOString() })
      .eq("id", rr.id);
  }

  // Org name + Google Business Profile URL (for the happy path redirect).
  const { data: orgRow } = await admin
    .from("organizations")
    .select("name")
    .eq("id", rr.organization_id)
    .maybeSingle();
  const orgName =
    (orgRow as unknown as { name: string | null } | null)?.name ?? "our service";

  const { data: settings } = await admin
    .from("notification_settings")
    .select("google_review_url")
    .eq("organization_id", rr.organization_id)
    .maybeSingle();
  const googleReviewUrl =
    (settings as unknown as { google_review_url: string | null } | null)?.google_review_url?.trim() ||
    null;

  // Personalize the greeting with the customer's name when available.
  let customerName: string | null = null;
  if (rr.customer_id) {
    const { data: cust } = await admin
      .from("customers")
      .select("name")
      .eq("id", rr.customer_id)
      .maybeSingle();
    customerName =
      (cust as unknown as { name: string | null } | null)?.name ?? null;
  }

  const alreadyAnswered = rr.status === "happy" || rr.status === "unhappy";

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-5" style={{ background: "#15803d" }}>
            <p className="text-white text-lg font-bold tracking-tight">
              {orgName}
            </p>
            <p className="text-green-100 text-xs uppercase tracking-wider mt-0.5">
              How did we do?
            </p>
          </div>
          <div className="p-6">
            <ReviewGate
              token={token}
              orgName={orgName}
              customerName={customerName}
              googleReviewUrl={googleReviewUrl}
              alreadyAnswered={alreadyAnswered}
            />
          </div>
        </div>
      </div>
    </div>
  );
}