import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import { computeTotal } from "@/lib/money";
import EstimateDocument from "@/components/EstimateDocument";
import EstimateDecisionButtons from "./EstimateDecisionButtons";

export const dynamic = "force-dynamic";

// Public customer estimate view — no auth. The share_token in the URL is the
// only credential. Fetched via the service role (validating the token). Office
// hits Send → customer opens this link → sees the estimate + Approve/Reject →
// decides. The /q/{token} URL is preserved from the old quote flow so
// already-emailed links keep working; the token now lives on the estimates row
// (migrated with the same id).
export default async function PublicEstimatePage({
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

  const { data: estimate } = await admin
    .from("estimates")
    .select(
      "id, status, customer_notes, valid_until, sent_at, approved_at, rejected_at, organization_id, jobs(name), customers(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!estimate) {
    notFound();
  }

  // Customer-safe columns only — no cost_code_id.
  const { data: lineItems } = await admin
    .from("estimate_line_items")
    .select("id, description, quantity, unit_price, position")
    .eq("estimate_id", estimate.id)
    .order("position");

  let orgName = "Terra Vista Construction";
  let orgAddress: string | null = null;
  let orgPhone: string | null = null;
  let orgEmail: string | null = null;
  if (estimate.organization_id) {
    const { data: o } = await admin
      .from("organizations")
      .select("name, address, phone, email")
      .eq("id", estimate.organization_id)
      .maybeSingle();
    if (o) {
      if (o.name) orgName = o.name;
      orgAddress = o.address;
      orgPhone = o.phone;
      orgEmail = o.email;
    }
  }

  const jobName =
    (estimate.jobs as unknown as { name: string } | null)?.name ?? "—";
  const customerName =
    (estimate.customers as unknown as { name: string } | null)?.name ?? "—";

  const items = (lineItems ?? []).map((i) => ({
    id: i.id,
    description: i.description,
    quantity: Number(i.quantity),
    unitPrice: Number(i.unit_price),
  }));
  const total = computeTotal(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unitPrice }))
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <EstimateDocument
        orgName={orgName}
        orgAddress={orgAddress}
        orgPhone={orgPhone}
        orgEmail={orgEmail}
        customerName={customerName}
        jobName={jobName}
        status={estimate.status}
        sentAt={estimate.sent_at}
        approvedAt={estimate.approved_at}
        rejectedAt={estimate.rejected_at}
        validUntil={estimate.valid_until}
        customerNotes={estimate.customer_notes}
        items={items}
        total={total}
      />

      {/* Decision buttons only while awaiting the customer */}
      {estimate.status === "sent" && (
        <div className="max-w-md mx-auto px-4">
          <EstimateDecisionButtons token={token} />
        </div>
      )}
    </div>
  );
}