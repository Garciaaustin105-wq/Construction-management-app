"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Eye, Pencil } from "lucide-react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import EstimateLineItemEditor, {
  type EstimateLine,
  type CostCodeOption,
} from "@/components/EstimateLineItemEditor";
import EstimateDocument from "@/components/EstimateDocument";
import EstimateOfficeActions from "./EstimateOfficeActions";
import CustomerEstimateActions from "./CustomerEstimateActions";
import { fetchPriorLineItems, type PriorItem } from "@/lib/estimateHistory";
import { computeTotal, formatMoney } from "@/lib/money";

type Estimate = {
  id: string;
  job_id: string;
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
  jobs: { name: string } | null;
  customers: { name: string | null; contact_email: string | null } | null;
};

type OrgInfo = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
};

type LineRow = {
  id: string;
  cost_code_id: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
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
    name: "Terra Vista Construction",
    address: null,
    phone: null,
    email: null,
  });
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

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
        .select("role")
        .eq("id", user.id)
        .single();
      const r = profile?.role ?? "crew";
      setRole(r);
      setAuthorized(true);

      const isOffice = r === "office" || r === "admin";

      const { data: est } = await supabase
        .from("estimates")
        .select(
          "id, job_id, title, status, note, customer_notes, valid_until, customer_id, created_at, sent_at, approved_at, rejected_at, organization_id, jobs(name), customers(name, contact_email)"
        )
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

      // Line items — office reads cost-coded rows; customer reads only
      // customer-safe columns (no cost_code_id, no unit).
      const lineSelect = isOffice
        ? "id, cost_code_id, description, quantity, unit, unit_price"
        : "id, description, quantity, unit_price";
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
        }))
      );

      // Org info for the customer-facing document.
      if (e.organization_id) {
        const { data: o } = await supabase
          .from("organizations")
          .select("name, address, phone, email")
          .eq("id", e.organization_id)
          .maybeSingle();
        if (o) {
          setOrg({
            name: o.name ?? org.name,
            address: o.address,
            phone: o.phone,
            email: o.email,
          });
        }
      }

      if (isOffice) {
        const [{ data: codeRows }, { data: inv }] = await Promise.all([
          supabase.from("cost_codes").select("id, code, name").order("code"),
          supabase
            .from("invoices")
            .select("id")
            .eq("estimate_id", paramId)
            .maybeSingle(),
        ]);
        setCostCodes((codeRows as CostCodeOption[]) ?? []);
        setPriorItems(await fetchPriorLineItems());
        if (inv?.id) setInvoiceId(inv.id);
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
  const customerEmail = estimate.customers?.contact_email ?? null;
  const jobName = estimate.jobs?.name ?? "—";

  const total = computeTotal(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unit_price }))
  );

  // ── Customer view: just the document (+ approve/reject while awaiting) ────
  if (isCustomer) {
    return (
      <div className="min-h-screen bg-gray-50 pb-24">
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

        <main className="max-w-md mx-auto p-4 space-y-4">
          <EstimateDocument
            orgName={org.name}
            orgAddress={org.address}
            orgPhone={org.phone}
            orgEmail={org.email}
            customerName={customerName}
            jobName={jobName}
            status={estimate.status}
            sentAt={estimate.sent_at}
            approvedAt={estimate.approved_at}
            rejectedAt={estimate.rejected_at}
            validUntil={estimate.valid_until}
            customerNotes={estimate.customer_notes}
            items={items.map((i, idx) => ({
              id: String(idx),
              description: i.description,
              quantity: i.quantity,
              unitPrice: i.unit_price,
            }))}
            total={total}
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
      <div className="min-h-screen bg-gray-50 pb-24">
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
        <main className="max-w-md mx-auto p-4">
          <EstimateDocument
            orgName={org.name}
            orgAddress={org.address}
            orgPhone={org.phone}
            orgEmail={org.email}
            customerName={customerName}
            jobName={jobName}
            status={estimate.status}
            sentAt={estimate.sent_at}
            approvedAt={estimate.approved_at}
            rejectedAt={estimate.rejected_at}
            validUntil={estimate.valid_until}
            customerNotes={estimate.customer_notes}
            items={items.map((i, idx) => ({
              id: String(idx),
              description: i.description,
              quantity: i.quantity,
              unitPrice: i.unit_price,
            }))}
            total={total}
          />
        </main>
      </div>
    );
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
        customer_notes: customerNotes.trim() || null,
        valid_until: validUntil || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (estError) {
      toast.error(`Save failed: ${estError.message}`);
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
    <div className="min-h-screen bg-gray-50 pb-24">
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

      <main className="max-w-md mx-auto p-4 space-y-4">
        {tab === "edit" ? (
          <>
            <section className="bg-white rounded-lg p-4 shadow-sm space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Link
                  href={`/jobs/${estimate.job_id}`}
                  className="text-sm font-semibold text-blue-700 truncate"
                >
                  {jobName}
                </Link>
                <span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-700 flex-shrink-0">
                  {STATUS_LABEL[estimate.status] ?? estimate.status}
                </span>
              </div>
              <p className="text-xs text-gray-400">
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

            <div className="bg-white rounded-lg p-3 shadow-sm text-sm">
              <p className="text-gray-500">Customer</p>
              <p className="text-gray-900 font-medium">{customerName}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {customerEmail
                  ? `Will be sent to ${customerEmail}`
                  : estimate.customer_id
                  ? "No email on file — add one in Customers before sending."
                  : "No customer linked to this job — add one in Customers."}
              </p>
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
              items={items.map((i, idx) => ({
                id: String(idx),
                description: i.description,
                quantity: i.quantity,
                unitPrice: i.unit_price,
              }))}
              total={total}
              preview={estimate.status === "draft"}
            />

            <EstimateOfficeActions
              estimateId={estimate.id}
              status={estimate.status}
              invoiceId={invoiceId}
              jobId={backJobId || null}
            />

            <p className="text-xs text-gray-400 text-center">
              Total {formatMoney(total)}
            </p>
          </>
        )}
      </main>
    </div>
  );
}