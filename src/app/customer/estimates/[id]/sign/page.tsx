import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import type { EstimatePricing } from "@/lib/money";
import PageContainer from "@/components/PageContainer";
import EstimateDocument from "@/components/EstimateDocument";
import ProposalSignPanel from "@/components/ProposalSignPanel";

export const dynamic = "force-dynamic";

// Authed Client Portal "Review & Sign" page for a proposal estimate. The
// customer must be signed in (magic link) — there is NO public/token signing
// path (locked decision: authed-only gives the strongest audit, a real
// auth.uid + IP). RLS session client scopes the read to this customer's own
// estimate (same_org + customer-own policy); only customer-safe columns are
// selected (no cost_code_id, no internal_cost, no note, no viewed_at) — the
// proposal columns requires_signature / proposal_intro / proposal_accent are
// customer-visible by design.
//
// Guard: requires_signature=true AND status='sent' — anything else (a plain
// estimate, an already-signed proposal, a draft) bounces to /customer so a
// bookmarked link after signing lands somewhere sensible.
export default async function ProposalSignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  // Must be a customer account (profiles.customer_id non-null) — the
  // sign_proposal RPC enforces this too, but bouncing here keeps the page
  // honest (an office user opening the link gets sent to /customer rather than
  // seeing a sign widget they can't use).
  const { data: profile } = await supabase
    .from("profiles")
    .select("customer_id")
    .eq("id", me.user.id)
    .maybeSingle();
  const customerId = profile?.customer_id ?? null;
  if (!customerId) redirect("/customer");

  // Customer-safe columns + the proposal layer. Scoped by customer_id so even
  // if RLS admitted other estimates, this customer only sees their own.
  const { data: est } = await supabase
    .from("estimates")
    .select(
      "id, title, status, customer_notes, valid_until, sent_at, approved_at, rejected_at, organization_id, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, exclusions, terms, payment_schedule, show_itemized, requires_signature, proposal_intro, proposal_accent, jobs(name, address), customers(name, address)"
    )
    .eq("id", id)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (!est) redirect("/customer");
  if (!est.requires_signature || est.status !== "sent") redirect("/customer");

  // Customer-safe line items (no cost_code_id, no internal_cost).
  const { data: lineItems } = await supabase
    .from("estimate_line_items")
    .select("id, description, quantity, unit_price, position, section")
    .eq("estimate_id", id)
    .order("position");

  // Org branding (logo from the public org-logos bucket → getPublicUrl, no
  // signed-URL expiry, renders on this authed customer page).
  let orgName = "";
  let orgAddress: string | null = null;
  let orgPhone: string | null = null;
  let orgEmail: string | null = null;
  let orgLogoUrl: string | null = null;
  if (est.organization_id) {
    const { data: o } = await supabase
      .from("organizations")
      .select("name, address, phone, email, logo_path")
      .eq("id", est.organization_id)
      .maybeSingle();
    if (o) {
      if (o.name) orgName = o.name;
      orgAddress = o.address;
      orgPhone = o.phone;
      orgEmail = o.email;
      if (o.logo_path) {
        orgLogoUrl = supabase.storage
          .from("org-logos")
          .getPublicUrl(o.logo_path).data.publicUrl;
      }
    }
  }

  const jobRow = est.jobs as unknown as
    | { name: string; address: string | null }
    | null;
  const custRow = est.customers as unknown as
    | { name: string; address: string | null }
    | null;
  const customerName = custRow?.name ?? "—";
  const jobName =
    jobRow?.name ?? (est.title as string | null) ?? customerName;
  const projectAddress = jobRow?.address ?? custRow?.address ?? null;

  const items = (lineItems ?? []).map((i) => ({
    id: i.id,
    description: i.description,
    quantity: Number(i.quantity),
    unitPrice: Number(i.unit_price),
    section: i.section ?? null,
  }));

  const pricing: EstimatePricing = {
    markupPct: Number(est.markup_pct) || 0,
    contingencyPct: Number(est.contingency_pct) || 0,
    taxPct: Number(est.tax_pct) || 0,
    depositPct: Number(est.deposit_pct) || 0,
    depositAmount: Number(est.deposit_amount) || 0,
  };

  const intro = (est.proposal_intro as string | null)?.trim() || null;
  const accent = ((est.proposal_accent as string | null) ?? "").trim();
  // Accent is office-authored hex; fall back to the brand dark so a bad/blank
  // value never produces an invisible header. Guarded so it only applies to a
  // valid-looking #rrggbb (defense against a stray typo in the column).
  const accentSafe = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : null;
  const accentStyle = accentSafe
    ? { backgroundColor: accentSafe }
    : undefined;

  return (
    <PageContainer title="Review & Sign" subtitle={me.user.email ?? ""} showSignOut backHref="/customer" backLabel="Portal" maxWidth="form">
      {/* Proposal cover — accent banner + intro letter, above the estimate */}
      <div className="overflow-hidden rounded-lg shadow-sm bg-white">
        <div
          className="px-5 py-4 text-white"
          style={
            accentStyle ?? { backgroundColor: "#1e293b" /* slate-800 brand-dark fallback */ }
          }
        >
          <p className="text-xs uppercase tracking-wider opacity-90">
            Proposal from {orgName || "your contractor"}
          </p>
          <p className="text-lg font-bold tracking-tight mt-0.5">
            {jobName}
          </p>
        </div>
        {intro && (
          <div className="p-4">
            <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
              {intro}
            </p>
          </div>
        )}
      </div>

      <EstimateDocument
        orgName={orgName}
        orgAddress={orgAddress}
        orgPhone={orgPhone}
        orgEmail={orgEmail}
        orgLogoUrl={orgLogoUrl}
        customerName={customerName}
        jobName={jobName}
        status={est.status}
        sentAt={est.sent_at}
        approvedAt={est.approved_at}
        rejectedAt={est.rejected_at}
        validUntil={est.valid_until}
        customerNotes={est.customer_notes}
        estimateNumber={est.estimate_number}
        projectAddress={projectAddress}
        pricing={pricing}
        showItemized={est.show_itemized ?? true}
        exclusions={est.exclusions}
        terms={est.terms}
        paymentSchedule={est.payment_schedule}
        items={items}
      />

      {/* E-signature widget — authed customer only */}
      <div className="bg-white rounded-lg shadow-sm p-4 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 uppercase">
          Sign to accept
        </h2>
        <ProposalSignPanel estimateId={id} />
      </div>
    </PageContainer>
  );
}