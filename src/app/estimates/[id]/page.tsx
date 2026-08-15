"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Eye, Pencil, UserPlus } from "lucide-react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import EstimateLineItemEditor, {
  type EstimateLine,
  type CostCodeOption,
} from "@/components/EstimateLineItemEditor";
import EstimateDocument from "@/components/EstimateDocument";
import NumberInput from "@/components/NumberInput";
import EstimateOfficeActions from "./EstimateOfficeActions";
import CustomerEstimateActions from "./CustomerEstimateActions";
import { fetchPriorLineItems, type PriorItem } from "@/lib/estimateHistory";
import {
  computeTotal,
  computeInternalCost,
  computeEstimateTotals,
  formatMoney,
  type EstimatePricing,
} from "@/lib/money";

type Estimate = {
  id: string;
  job_id: string | null;
  title: string | null;
  status: string;
  note: string | null;
  customer_notes: string | null;
  valid_until: string | null;
  customer_id: string | null;
  created_at: string;
  sent_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  organization_id: string | null;
  estimate_number: string | null;
  markup_pct: number;
  contingency_pct: number;
  tax_pct: number;
  deposit_pct: number;
  deposit_amount: number;
  exclusions: string | null;
  terms: string | null;
  payment_schedule: string | null;
  show_itemized: boolean;
  viewed_at: string | null;
  jobs: { name: string; address: string | null } | null;
  customers: { name: string | null; contact_email: string | null; address: string | null } | null;
};

type OrgInfo = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  // White-label logo public URL (resolved once when the org loads, so render
  // doesn't need a live supabase client — getPublicUrl only builds a string).
  logoUrl: string | null;
};

type LineRow = {
  id: string;
  cost_code_id: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  internal_cost: number | null;
  section: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  converted: "Converted",
  rejected: "Rejected",
};

export default function EstimateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [id, setId] = useState<string>("");
  const [backJobId, setBackJobId] = useState<string>("");
  const [role, setRole] = useState<string>("crew");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [items, setItems] = useState<EstimateLine[]>([]);
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  const [priorItems, setPriorItems] = useState<PriorItem[]>([]);
  const [org, setOrg] = useState<OrgInfo>({
    name: "",
    address: null,
    phone: null,
    email: null,
    logoUrl: null,
  });
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [estimateNumber, setEstimateNumber] = useState("");
  const [markupPct, setMarkupPct] = useState(0);
  const [contingencyPct, setContingencyPct] = useState(0);
  const [taxPct, setTaxPct] = useState(0);
  const [depositPct, setDepositPct] = useState(0);
  const [depositAmount, setDepositAmount] = useState(0);
  const [exclusions, setExclusions] = useState("");
  const [terms, setTerms] = useState("");
  const [paymentSchedule, setPaymentSchedule] = useState("");
  const [showItemized, setShowItemized] = useState(true);
  const [viewedAt, setViewedAt] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  // Editable customer picker (office) — lets the office attach or change the
  // customer on an existing estimate, including adding a brand-new customer
  // inline. Without this a job-linked estimate whose job has no customer, or a
  // standalone estimate created without one, had no way to get a recipient —
  // the edit form only showed the customer as read-only text.
  const [customers, setCustomers] = useState<
    { id: string; name: string; contact_email: string | null }[]
  >([]);
  const [customerId, setCustomerId] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [showNewCust, setShowNewCust] = useState(false);
  const [newCustName, setNewCustName] = useState("");
  const [newCustEmail, setNewCustEmail] = useState("");
  const [addingCust, setAddingCust] = useState(false);

  useEffect(() => {
    (async () => {
      const { id: paramId } = await params;
      setId(paramId);
      const { job: jobParam } = await searchParams;
      setBackJobId(jobParam ?? "");
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, organization_id")
        .eq("id", user.id)
        .single();
      const r = profile?.role ?? "crew";
      setRole(r);
      setOrgId(profile?.organization_id ?? null);
      setAuthorized(true);

      const isOffice = r === "office" || r === "admin";

      // Office reads every column (including the office-only viewed_at + note);
      // customer/crew read a customer-safe subset (no viewed_at, no note, no
      // internal_cost/cost_code_id). Both join jobs(name, address) for the doc.
      // Typed as a plain string (not a literal union) so the supabase client's
      // deep row-inference doesn't blow up (TS2589) on the long column list —
      // we cast the result to `Estimate` below regardless.
      const estSelect: string = isOffice
        ? "id, job_id, title, status, note, customer_notes, valid_until, customer_id, created_at, sent_at, approved_at, rejected_at, organization_id, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, exclusions, terms, payment_schedule, show_itemized, viewed_at, jobs(name, address), customers(name, contact_email, address)"
        : "id, job_id, title, status, customer_notes, valid_until, customer_id, created_at, sent_at, approved_at, rejected_at, organization_id, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, exclusions, terms, payment_schedule, show_itemized, jobs(name, address), customers(name, contact_email, address)";
      const { data: est } = await supabase
        .from("estimates")
        .select(estSelect)
        .eq("id", paramId)
        .single();

      if (!est) {
        toast.error("Estimate not found");
        router.push("/estimates");
        return;
      }
      const e = est as unknown as Estimate;
      setEstimate(e);
      setTitle(e.title ?? "");
      setNote(e.note ?? "");
      setCustomerNotes(e.customer_notes ?? "");
      setValidUntil(e.valid_until ?? "");
      setEstimateNumber(e.estimate_number ?? "");
      setMarkupPct(Number(e.markup_pct) || 0);
      setContingencyPct(Number(e.contingency_pct) || 0);
      setTaxPct(Number(e.tax_pct) || 0);
      setDepositPct(Number(e.deposit_pct) || 0);
      setDepositAmount(Number(e.deposit_amount) || 0);
      setExclusions(e.exclusions ?? "");
      setTerms(e.terms ?? "");
      setPaymentSchedule(e.payment_schedule ?? "");
      setShowItemized(e.show_itemized ?? true);
      setViewedAt(e.viewed_at ?? null);

      // Line items — office reads cost-coded rows + internal_cost + section;
      // customer reads only customer-safe columns (no cost_code_id, no unit,
      // no internal_cost). Section is customer-visible.
      const lineSelect = isOffice
        ? "id, cost_code_id, description, quantity, unit, unit_price, internal_cost, section"
        : "id, description, quantity, unit_price, section";
      const { data: lineRows } = await supabase
        .from("estimate_line_items")
        .select(lineSelect)
        .eq("estimate_id", paramId)
        .order("position");
      setItems(
        (lineRows as LineRow[] | null ?? []).map((row) => ({
          cost_code_id: (row as LineRow).cost_code_id ?? null,
          description: row.description ?? "",
          quantity: Number(row.quantity) || 0,
          unit: row.unit ?? "EA",
          unit_price: Number(row.unit_price) || 0,
          section: row.section ?? "",
          internal_cost:
            row.internal_cost != null ? Number(row.internal_cost) : null,
        }))
      );

      // Org info for the customer-facing document.
      if (e.organization_id) {
        const { data: o } = await supabase
          .from("organizations")
          .select("name, address, phone, email, logo_path")
          .eq("id", e.organization_id)
          .maybeSingle();
        if (o) {
          setOrg({
            name: o.name ?? org.name,
            address: o.address,
            phone: o.phone,
            email: o.email,
            logoUrl: o.logo_path
              ? supabase.storage.from("org-logos").getPublicUrl(o.logo_path)
                  .data.publicUrl
              : null,
          });
        }
      }

      if (isOffice) {
        const [{ data: codeRows }, { data: inv }, { data: custRows }] =
          await Promise.all([
            supabase.from("cost_codes").select("id, code, name").order("code"),
            supabase
              .from("invoices")
              .select("id")
              .eq("estimate_id", paramId)
              .maybeSingle(),
            supabase
              .from("customers")
              .select("id, name, contact_email")
              .order("name"),
          ]);
        setCostCodes((codeRows as CostCodeOption[]) ?? []);
        setPriorItems(await fetchPriorLineItems());
        if (inv?.id) setInvoiceId(inv.id);
        setCustomers(
          (custRows as {
            id: string;
            name: string;
            contact_email: string | null;
          }[]) ?? []
        );
        setCustomerId(e.customer_id ?? "");
      }

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, searchParams, router, toast]);

  if (!authorized || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (!estimate) return null;

  const isOffice = role === "office" || role === "admin";
  const isCustomer = role === "customer";
  const editable = estimate.status === "draft" || estimate.status === "sent";
  const backHref = backJobId
    ? `/jobs/${backJobId}`
    : isCustomer
    ? "/customer"
    : "/estimates";
  const backLabel = backJobId
    ? "Back to job"
    : isCustomer
    ? "Portal"
    : "Estimates";

  const customerName = estimate.customers?.name ?? "—";
  const customerAddress = estimate.customers?.address ?? null;
  // The customer the office has selected in the picker (live, pre-save). Used
  // for the "will be sent to" hint so it reflects a just-picked/just-added
  // customer before the estimate is saved + reloaded.
  const selectedCustomer =
    customers.find((c) => c.id === customerId) ?? null;
  // Standalone (job-less) estimates label the project with the title (or the
  // customer name) instead of "—", and use the customer's address as the
  // project address when there's no job address.
  const jobName = estimate.jobs?.name ?? estimate.title ?? customerName;
  const projectAddress = estimate.jobs?.address ?? customerAddress ?? null;
  const isStandalone = !estimate.job_id;

  const pricing: EstimatePricing = {
    markupPct,
    contingencyPct,
    taxPct,
    depositPct,
    depositAmount,
  };
  const totals = computeEstimateTotals(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unit_price })),
    pricing
  );
  const hasPricing =
    totals.markupAmount > 0 ||
    totals.contingencyAmount > 0 ||
    totals.taxAmount > 0 ||
    totals.depositAmount > 0;
  const grandTotal = hasPricing ? totals.grandTotal : totals.subtotal;
  const sellTotal = computeTotal(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unit_price }))
  );
  const internalCostTotal = computeInternalCost(items);

  // ── Customer view: just the document (+ approve/reject while awaiting) ────
  if (isCustomer) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
        <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <button
            onClick={() => router.push(backHref)}
            className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
          >
            <ArrowLeft className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{backLabel}</span>
          </button>
          <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[55%]">
            Estimate
          </h1>
          <div className="w-16" />
        </header>

        <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
          <EstimateDocument
            orgName={org.name}
            orgAddress={org.address}
            orgPhone={org.phone}
            orgEmail={org.email}
            orgLogoUrl={org.logoUrl}
            customerName={customerName}
            jobName={jobName}
            status={estimate.status}
            sentAt={estimate.sent_at}
            approvedAt={estimate.approved_at}
            rejectedAt={estimate.rejected_at}
            validUntil={estimate.valid_until}
            customerNotes={estimate.customer_notes}
            estimateNumber={estimate.estimate_number}
            projectAddress={projectAddress}
            pricing={pricing}
            showItemized={estimate.show_itemized}
            exclusions={estimate.exclusions}
            terms={estimate.terms}
            paymentSchedule={estimate.payment_schedule}
            items={items.map((i, idx) => ({
              id: String(idx),
              description: i.description,
              quantity: i.quantity,
              unitPrice: i.unit_price,
              section: i.section,
            }))}
          />

          {estimate.status === "sent" && (
            <CustomerEstimateActions estimateId={estimate.id} />
          )}
        </main>
      </div>
    );
  }

  // ── Non-office, non-customer (e.g. crew/PM) → read-only document ──────────
  if (!isOffice) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
        <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <button
            onClick={() => router.push(backHref)}
            className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
          >
            <ArrowLeft className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{backLabel}</span>
          </button>
          <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[55%]">
            {estimate.title || "Estimate"}
          </h1>
          <div className="w-16" />
        </header>
        <main className="max-w-md lg:max-w-5xl mx-auto p-4">
          <EstimateDocument
            orgName={org.name}
            orgAddress={org.address}
            orgPhone={org.phone}
            orgEmail={org.email}
            orgLogoUrl={org.logoUrl}
            customerName={customerName}
            jobName={jobName}
            status={estimate.status}
            sentAt={estimate.sent_at}
            approvedAt={estimate.approved_at}
            rejectedAt={estimate.rejected_at}
            validUntil={estimate.valid_until}
            customerNotes={estimate.customer_notes}
            estimateNumber={estimate.estimate_number}
            projectAddress={projectAddress}
            pricing={pricing}
            showItemized={estimate.show_itemized}
            exclusions={estimate.exclusions}
            terms={estimate.terms}
            paymentSchedule={estimate.payment_schedule}
            items={items.map((i, idx) => ({
              id: String(idx),
              description: i.description,
              quantity: i.quantity,
              unitPrice: i.unit_price,
              section: i.section,
            }))}
          />
        </main>
      </div>
    );
  }

  // Inline "new customer" on the estimate — inserts a customer (root table,
  // app-supplied org) then refreshes the list and auto-selects it. Mirrors the
  // creator + CustomersManager so the office can attach a brand-new customer
  // without leaving the estimate.
  async function addCustomer() {
    if (!newCustName.trim()) {
      toast.warning("Customer name is required");
      return;
    }
    if (!orgId) {
      toast.error("No organization on your profile — contact an admin.");
      return;
    }
    setAddingCust(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: newCustName.trim(),
        contact_email: newCustEmail.trim() || null,
        organization_id: orgId,
      })
      .select("id, name, contact_email")
      .single();
    setAddingCust(false);
    if (error || !data) {
      toast.error(`Failed: ${error?.message ?? "error"}`);
      return;
    }
    const row = data as {
      id: string;
      name: string;
      contact_email: string | null;
    };
    setCustomers((prev) =>
      [...prev, row].sort((a, b) => a.name.localeCompare(b.name))
    );
    setCustomerId(row.id);
    setNewCustName("");
    setNewCustEmail("");
    setShowNewCust(false);
    toast.success("Customer added");
  }

  // ── Office: Edit / Preview & Send tabs ────────────────────────────────────
  async function saveEstimate() {
    if (!id) return;
    const validItems = items.filter(
      (i) => i.description.trim() || i.cost_code_id
    );
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
      return;
    }
    setSaving(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();

    const { error: estError } = await supabase
      .from("estimates")
      .update({
        title: title.trim() || null,
        note: note.trim() || null,
        customer_id: customerId || null,
        customer_notes: customerNotes.trim() || null,
        valid_until: validUntil || null,
        estimate_number: estimateNumber.trim() || null,
        markup_pct: Number(markupPct) || 0,
        contingency_pct: Number(contingencyPct) || 0,
        tax_pct: Number(taxPct) || 0,
        deposit_pct: Number(depositPct) || 0,
        deposit_amount: Number(depositAmount) || 0,
        exclusions: exclusions.trim() || null,
        terms: terms.trim() || null,
        payment_schedule: paymentSchedule.trim() || null,
        show_itemized: showItemized,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (estError) {
      // 23505 = the edited estimate_number collides with another estimate in
      // this org (partial unique index). Surface a clear message.
      if (estError.code === "23505") {
        toast.error(
          "That estimate number is already used by another estimate in your organization."
        );
      } else {
        toast.error(`Save failed: ${estError.message}`);
      }
      setSaving(false);
      return;
    }

    // Replace all line items (delete + reinsert with fresh positions).
    await supabase.from("estimate_line_items").delete().eq("estimate_id", id);
    const lineInserts = validItems.map((item, idx) => ({
      estimate_id: id,
      cost_code_id: item.cost_code_id ?? null,
      description: item.description.trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      section: item.section || null,
      internal_cost: item.internal_cost ?? null,
      position: idx,
    }));
    const { error: linesError } = await supabase
      .from("estimate_line_items")
      .insert(lineInserts);
    if (linesError) {
      toast.error(`Save failed: ${linesError.message}`);
    } else {
      toast.success("Estimate saved");
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(backHref)}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{backLabel}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[55%]">
          {estimate.title || "Estimate"}
        </h1>
        <div className="w-16" />
      </header>

      {/* Tab switch */}
      <div className="sticky top-[57px] z-30 bg-white border-b border-gray-200">
        <div className="max-w-md mx-auto flex">
          <button
            onClick={() => setTab("edit")}
            className={`flex-1 py-2.5 text-sm font-semibold flex items-center justify-center gap-1.5 ${
              tab === "edit"
                ? "text-blue-700 border-b-2 border-blue-700"
                : "text-gray-500"
            }`}
          >
            <Pencil className="w-4 h-4" />
            Edit
          </button>
          <button
            onClick={() => setTab("preview")}
            className={`flex-1 py-2.5 text-sm font-semibold flex items-center justify-center gap-1.5 ${
              tab === "preview"
                ? "text-blue-700 border-b-2 border-blue-700"
                : "text-gray-500"
            }`}
          >
            <Eye className="w-4 h-4" />
            Preview &amp; Send
          </button>
        </div>
      </div>

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        {tab === "edit" ? (
          <>
            <section className="bg-white rounded-lg p-4 shadow-sm space-y-1">
              <div className="flex items-center justify-between gap-2">
                {estimate.job_id ? (
                  <Link
                    href={`/jobs/${estimate.job_id}`}
                    className="text-sm font-semibold text-blue-700 truncate"
                  >
                    {jobName}
                  </Link>
                ) : (
                  <span className="text-sm font-semibold text-gray-700 truncate">
                    {customerName}
                  </span>
                )}
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-700 flex-shrink-0">
                  {STATUS_LABEL[estimate.status] ?? estimate.status}
                </span>
              </div>
              <p className="text-xs text-gray-400">
                {isStandalone && "Standalone estimate · "}
                {new Date(estimate.created_at).toLocaleDateString()}
              </p>
            </section>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Title (optional)
              </span>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!editable}
                placeholder="e.g. Site work & electrical estimate"
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Estimate number
              </span>
              <input
                type="text"
                value={estimateNumber}
                onChange={(e) => setEstimateNumber(e.target.value)}
                disabled={!editable}
                placeholder="EST-0001"
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
              <span className="text-xs text-gray-400 mt-1 block">
                Auto-generated (EST-0001…). Edit to override — must be unique
                within your organization.
              </span>
            </label>

            <div>
              <span className="text-sm font-medium text-gray-700">
                Line items
              </span>
              <div className="mt-2">
                <EstimateLineItemEditor
                  items={items}
                  onChange={setItems}
                  costCodes={costCodes}
                  priorItems={priorItems}
                  disabled={!editable}
                />
              </div>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Internal note (optional)
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={!editable}
                placeholder="Notes for the office team (not shown to the customer)"
                rows={2}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Customer note (optional)
              </span>
              <textarea
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                disabled={!editable}
                placeholder="Shown to the customer on the estimate"
                rows={2}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Valid until (optional)
              </span>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                disabled={!editable}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            {/* Pricing summary — markup/contingency/tax/deposit */}
            <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
              <p className="text-sm font-semibold text-gray-700">
                Pricing summary
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs text-gray-500">Markup %</span>
                  <NumberInput
                    value={markupPct}
                    onChange={setMarkupPct}
                    disabled={!editable}
                    className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">Contingency %</span>
                  <NumberInput
                    value={contingencyPct}
                    onChange={setContingencyPct}
                    disabled={!editable}
                    className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">Sales tax %</span>
                  <NumberInput
                    value={taxPct}
                    onChange={setTaxPct}
                    disabled={!editable}
                    className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">Deposit %</span>
                  <NumberInput
                    value={depositPct}
                    onChange={setDepositPct}
                    disabled={!editable}
                    className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs text-gray-500">
                  Deposit amount $ (overrides the % above when set)
                </span>
                <NumberInput
                  value={depositAmount}
                  onChange={setDepositAmount}
                  disabled={!editable}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-50"
                />
              </label>
              {/* Computed grand total preview */}
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">Subtotal</span>
                  <span className="tabular-nums">{formatMoney(sellTotal)}</span>
                </div>
                {totals.markupAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Markup</span>
                    <span className="tabular-nums">{formatMoney(totals.markupAmount)}</span>
                  </div>
                )}
                {totals.contingencyAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Contingency</span>
                    <span className="tabular-nums">{formatMoney(totals.contingencyAmount)}</span>
                  </div>
                )}
                {totals.taxAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Tax</span>
                    <span className="tabular-nums">{formatMoney(totals.taxAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between pt-1 border-t border-gray-200 font-semibold">
                  <span>Grand total</span>
                  <span className="tabular-nums">{formatMoney(grandTotal)}</span>
                </div>
                {totals.depositAmount > 0 && (
                  <div className="flex justify-between text-gray-500">
                    <span>Deposit due</span>
                    <span className="tabular-nums">{formatMoney(totals.depositAmount)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Itemized vs lump-sum toggle */}
            <label className="flex items-center justify-between bg-white rounded-lg p-4 shadow-sm">
              <span className="text-sm font-medium text-gray-700">
                Show itemized line items
              </span>
              <input
                type="checkbox"
                checked={showItemized}
                onChange={(e) => setShowItemized(e.target.checked)}
                disabled={!editable}
                className="w-5 h-5"
              />
            </label>
            {!showItemized && (
              <p className="text-xs text-gray-400 -mt-2">
                When off, the customer sees a lump-sum total instead of the
                line-by-line breakdown.
              </p>
            )}

            {/* Office margin panel — internal cost vs sell (never shown to
                customers; internal_cost is office-only). */}
            {internalCostTotal > 0 && (
              <div className="bg-gray-900 text-white rounded-lg p-4 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-300">Sell total</span>
                  <span className="tabular-nums">{formatMoney(sellTotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-300">Internal cost</span>
                  <span className="tabular-nums">{formatMoney(internalCostTotal)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Margin</span>
                  <span className={`tabular-nums ${sellTotal - internalCostTotal < 0 ? "text-red-300" : "text-green-300"}`}>
                    {formatMoney(sellTotal - internalCostTotal)}{" "}
                    ({sellTotal > 0
                      ? ((sellTotal - internalCostTotal) / sellTotal * 100).toFixed(1)
                      : "0"}%)
                  </span>
                </div>
              </div>
            )}

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Exclusions (optional)
              </span>
              <textarea
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
                disabled={!editable}
                placeholder="What this estimate does NOT cover (e.g. permits, fixtures supplied by owner)"
                rows={2}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Terms &amp; conditions (optional)
              </span>
              <textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                disabled={!editable}
                placeholder="Payment due on completion. 1-year workmanship warranty…"
                rows={3}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Payment schedule (optional)
              </span>
              <textarea
                value={paymentSchedule}
                onChange={(e) => setPaymentSchedule(e.target.value)}
                disabled={!editable}
                placeholder="e.g. 25% deposit at signing, 65% at rough-in, 10% at final walk-through"
                rows={2}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>

            <div className="bg-white rounded-lg p-3 shadow-sm text-sm space-y-2">
              <span className="text-gray-500 block">Customer</span>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                <option value="">Select customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.contact_email ? ` · ${c.contact_email}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                {!customerId
                  ? "No customer linked — pick one or add a new customer so the estimate knows who to send to."
                  : selectedCustomer?.contact_email
                  ? `Will be sent to ${selectedCustomer.contact_email}`
                  : "No email on file — add one in Customers before sending."}
              </p>
              <button
                type="button"
                onClick={() => setShowNewCust((v) => !v)}
                className="text-sm text-blue-600 flex items-center gap-1"
              >
                <UserPlus className="w-4 h-4" />
                {showNewCust ? "Cancel new customer" : "New customer"}
              </button>
              {showNewCust && (
                <div className="bg-gray-50 rounded-lg p-2 space-y-2">
                  <input
                    type="text"
                    placeholder="Customer / company name *"
                    value={newCustName}
                    onChange={(e) => setNewCustName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <input
                    type="email"
                    placeholder="Contact email (used to send the estimate)"
                    value={newCustEmail}
                    onChange={(e) => setNewCustEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <button
                    type="button"
                    onClick={addCustomer}
                    disabled={addingCust}
                    className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {addingCust ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    Add customer
                  </button>
                </div>
              )}
            </div>

            {editable && (
              <button
                onClick={saveEstimate}
                disabled={saving}
                className="w-full bg-white border border-gray-300 text-gray-900 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {saving ? "Saving..." : "Save changes"}
              </button>
            )}

            {!editable && (
              <p className="text-xs text-gray-500 text-center">
                {estimate.status === "approved"
                  ? "Approved estimates are read-only."
                  : estimate.status === "rejected"
                  ? "Rejected estimates are read-only."
                  : "This estimate is read-only."}
              </p>
            )}
          </>
        ) : (
          <>
            {viewedAt && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-2 text-center text-xs text-blue-800">
                Viewed by the customer on{" "}
                {new Date(viewedAt).toLocaleString()}
              </div>
            )}
            <EstimateDocument
              orgName={org.name}
              orgAddress={org.address}
              orgPhone={org.phone}
              orgEmail={org.email}
              customerName={customerName}
              jobName={jobName}
              status={estimate.status === "draft" ? "sent" : estimate.status}
              validUntil={validUntil || null}
              customerNotes={customerNotes || null}
              estimateNumber={estimateNumber || null}
              projectAddress={projectAddress}
              pricing={pricing}
              showItemized={showItemized}
              exclusions={exclusions || null}
              terms={terms || null}
              paymentSchedule={paymentSchedule || null}
              items={items.map((i, idx) => ({
                id: String(idx),
                description: i.description,
                quantity: i.quantity,
                unitPrice: i.unit_price,
                section: i.section,
              }))}
              preview={estimate.status === "draft"}
            />

            <EstimateOfficeActions
              estimateId={estimate.id}
              status={estimate.status}
              invoiceId={invoiceId}
              jobId={backJobId || null}
            />

            <p className="text-xs text-gray-400 text-center">
              Grand total {formatMoney(grandTotal)}
            </p>
          </>
        )}
      </main>
    </div>
  );
}