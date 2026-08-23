import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { notFound, redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import HighlightsHeader from "@/components/ui/HighlightsHeader";
import Card from "@/components/ui/Card";
import SectionHeader from "@/components/SectionHeader";
// Labels + tones come from the invoice lifecycle module — the single source
// shared with the list page. (The local copies this replaced had drifted:
// void was `neutral` here and `muted` on the list.)
import {
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  type InvoiceStatus,
} from "@/lib/lifecycles/invoice";

import { formatMoney, computeTotal } from "@/lib/money";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import { listProviderOptions } from "@/lib/accounting/provider";
import "@/lib/accounting/providers"; // registers adapters so listProviderOptions resolves
import InvoiceActions from "./InvoiceActions";
import InvoiceDueDate from "./InvoiceDueDate";
import Link from "next/link";

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ job?: string }>;
}) {
  const { id } = await params;
  const { job: jobParam } = await searchParams;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  // invoice / lineItems / paymentRows are all independent reads — each depends
  // only on `id` (the route param), never on each other's results — so fetch
  // them concurrently instead of sequentially. (The caller's role comes from
  // the request-cached getMe(), so it costs no query here.)
  const [
    { data: invoice },
    { data: lineItems },
    { data: paymentRows },
  ] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "id, status, paid_at, sent_at, created_at, due_date, job_id, customer_id, estimate_id, amount_paid, accounting_external_id, jobs(name), customers(name, contact_email, phone)"
      )
      .eq("id", id)
      .single(),
    supabase
      .from("invoice_line_items")
      .select("id, description, quantity, unit_price, position")
      .eq("invoice_id", id)
      .order("position"),
    // Recorded offline payments (cash / check / other). RLS scopes reads to
    // office / customer (their invoice) / accountant. profiles(full_name)
    // gives the recorder name via the recorded_by FK.
    supabase
      .from("payments")
      .select(
        "id, amount, method, reference, paid_at, created_at, profiles(full_name)"
      )
      .eq("invoice_id", id)
      .order("paid_at", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);
  const role = me.role;

  if (!invoice) notFound();

  const items = lineItems ?? [];
  const total = computeTotal(
    items.map((i) => ({ quantity: Number(i.quantity), unit_price: Number(i.unit_price) }))
  );
  // amount_paid is seeded with the estimate deposit on approval (or 0 for a
  // deposit-owed invoice). Recording a cash/check payment ACCUMULATES into it
  // (see /api/invoices/[id]/payments). The balance due is the grand total minus
  // what's been paid (0 when fully paid).
  const amountPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - amountPaid);

  const payments = (
    (paymentRows as unknown as Array<{
      id: string;
      amount: number | string;
      method: string;
      reference: string | null;
      paid_at: string;
      created_at: string;
      profiles: { full_name: string | null } | null;
    }> | null) ?? []
  ).map((p) => ({
    id: p.id,
    amount: Number(p.amount) || 0,
    method: p.method,
    reference: p.reference,
    paid_at: p.paid_at,
    recorded_by_name: p.profiles?.full_name ?? null,
  }));
  const jobName = (invoice.jobs as unknown as { name: string } | null)?.name ?? "—";
  const customerRow = invoice.customers as unknown as
    | { name: string | null; contact_email: string | null; phone: string | null }
    | null;
  const customerName = customerRow?.name ?? "—";
  const customerEmail = customerRow?.contact_email?.trim() || null;
  const customerPhone = customerRow?.phone?.trim() || null;
  const accountingExternalId =
    (invoice.accounting_external_id as string | null) ?? null;

  // Office-only: which accounting providers this org has connected, so the
  // office can push the invoice to its bookkeeping (QBO/Xero/FreshBooks).
  // accounting_connections RLS is tier_office, so the session read returns only
  // this office's rows (empty for non-office roles). listProviderOptions reads
  // the adapter registry populated by the providers.ts side-effect import.
  const isOffice =
    role === "office" || role === "admin" || role === "project_manager";
  // The DB column is `text`; the lifecycle module owns the domain.
  const status = invoice.status as InvoiceStatus;
  let connectedProviders: { id: string; label: string }[] = [];
  if (isOffice) {
    const { data: conns } = await supabase
      .from("accounting_connections")
      .select("provider, status")
      .eq("status", "active");
    const activeIds = new Set((conns ?? []).map((c) => c.provider as string));
    connectedProviders = listProviderOptions().filter((p) =>
      activeIds.has(p.id)
    );
  }

  return (
    <PageContainer title="Invoice" subtitle={customerName} backHref={jobParam ? `/jobs/${jobParam}` : undefined} backLabel={jobParam ? "Back to job" : undefined} maxWidth="list">
      <HighlightsHeader
        title={customerName}
        subtitle={
          invoice.job_id ? (
            <Link href={`/jobs/${invoice.job_id}`} className="text-blue-600 underline">
              {jobName}
            </Link>
          ) : (
            "Standalone estimate (no job)"
          )
        }
        status={{
          label: INVOICE_STATUS_LABEL[status] ?? invoice.status,
          tone: INVOICE_STATUS_TONE[status] ?? "neutral",
        }}
        accent={INVOICE_STATUS_TONE[status] ?? "brand"}
        fields={[
          {
            label: "Total",
            value: (
              <span className="text-lg font-bold text-gray-900">{formatMoney(total)}</span>
            ),
          },
          { label: "Issued", value: new Date(invoice.created_at).toLocaleDateString() },
          {
            label: "Sent",
            value: invoice.sent_at
              ? new Date(invoice.sent_at).toLocaleDateString()
              : "—",
          },
          {
            label: "Paid",
            value: invoice.paid_at
              ? new Date(invoice.paid_at).toLocaleDateString()
              : "—",
          },
        ]}
      />

      <Card>
        <InvoiceDueDate
          invoiceId={invoice.id}
          initial={invoice.due_date}
          canEdit={
            role === "office" ||
            role === "admin" ||
            role === "project_manager"
          }
        />
        {amountPaid > 0 && invoice.status !== "paid" && (
          <div className="mt-3 pt-3 border-t border-line space-y-1 text-sm">
            <div className="flex justify-between text-muted">
              <span>Invoice total</span>
              <span className="tabular-nums">{formatMoney(total)}</span>
            </div>
            <div className="flex justify-between text-muted">
              <span>Paid so far</span>
              <span className="tabular-nums">−{formatMoney(amountPaid)}</span>
            </div>
            <div className="flex justify-between font-semibold text-gray-900">
              <span>Balance due</span>
              <span className="tabular-nums">{formatMoney(balanceDue)}</span>
            </div>
          </div>
        )}
      </Card>

      {invoice.estimate_id && (
        <Link
          href={`/estimates/${invoice.estimate_id}${jobParam ? `?job=${jobParam}` : ""}`}
          className="block bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900 active:bg-blue-100"
        >
          ← View source estimate
        </Link>
      )}

      <section>
        <SectionHeader className="mb-2">Line items ({items.length})</SectionHeader>
        {items.length === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={EmptyIcons.FileText}
              title="No line items"
              description="This invoice has no items."
            />
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm divide-y">
            {items.map((item) => {
              const lineTotal =
                Number(item.quantity) * Number(item.unit_price);
              return (
                <div key={item.id} className="p-3">
                  <div className="flex justify-between items-start gap-2">
                    <p className="text-sm text-gray-900 flex-1 min-w-0">
                      {item.description}
                    </p>
                    <p className="text-sm font-semibold text-gray-900">
                      {formatMoney(lineTotal)}
                    </p>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {item.quantity} × {formatMoney(Number(item.unit_price))}
                  </p>
                </div>
              );
            })}
            <div className="p-3 bg-gray-50 flex justify-between items-center rounded-b-lg">
              <span className="text-sm font-semibold text-gray-900">Total</span>
              <span className="text-base font-bold text-gray-900">
                {formatMoney(total)}
              </span>
            </div>
          </div>
        )}
      </section>

      {/* Recorded offline payments (cash / check / other). The office can
          record more via the Record payment button in InvoiceActions. */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
          Payments ({payments.length})
        </h2>
        {payments.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm p-3 text-sm text-gray-500">
            No payments recorded yet
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm divide-y">
            {payments.map((p) => {
              const chip =
                p.method === "cash"
                  ? "bg-green-100 text-green-700"
                  : p.method === "check"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-600";
              return (
                <div key={p.id} className="p-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase ${chip}`}
                      >
                        {p.method}
                      </span>
                      <span className="text-sm font-semibold text-gray-900 tabular-nums">
                        {formatMoney(p.amount)}
                      </span>
                    </div>
                    {p.reference && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">
                        Ref: {p.reference}
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-0.5">
                      {new Date(p.paid_at).toLocaleDateString()}
                      {p.recorded_by_name ? ` · by ${p.recorded_by_name}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
            <div className="p-3 bg-gray-50 flex justify-between items-center rounded-b-lg">
              <span className="text-sm font-semibold text-gray-900">Paid so far</span>
              <span className="text-base font-bold text-gray-900 tabular-nums">
                {formatMoney(amountPaid)}
              </span>
            </div>
          </div>
        )}
      </section>

      {(role === "office" || role === "admin" || role === "project_manager") && (
        <InvoiceActions
          invoiceId={invoice.id}
          status={status}
          balanceDue={balanceDue}
          customerEmail={customerEmail}
          customerPhone={customerPhone}
          connectedProviders={connectedProviders}
          accountingExternalId={accountingExternalId}
        />
      )}
    </PageContainer>
  );
}