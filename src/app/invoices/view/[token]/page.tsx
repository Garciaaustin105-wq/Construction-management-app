import { createClient as createAdminClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";
import InvoiceDocument from "@/components/InvoiceDocument";
import InvoiceStatusBanner from "./InvoiceStatusBanner";
import InvoicePayActions from "./InvoicePayActions";
import { computeTotal, formatMoney } from "@/lib/money";
import { isLawn } from "@/lib/variant";

export const dynamic = "force-dynamic";

export default async function PublicInvoicePage({
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

  const { data: invoice } = await admin
    .from("invoices")
    .select(
      "id, status, due_date, sent_at, created_at, amount_paid, organization_id, jobs(name), customers(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!invoice) {
    notFound();
  }

  const { data: lineItems } = await admin
    .from("invoice_line_items")
    .select("id, description, quantity, unit_price, position")
    .eq("invoice_id", invoice.id)
    .order("position");

  let orgName = "";
  let orgAddress: string | null = null;
  let orgPhone: string | null = null;
  let orgEmail: string | null = null;
  let orgLogoUrl: string | null = null;
  let paymentsEnabled = false;
  if (invoice.organization_id) {
    const { data: o } = await admin
      .from("organizations")
      .select(
        "name, address, phone, email, logo_path, connect_charges_enabled, connect_losses_owner"
      )
      .eq("id", invoice.organization_id)
      .maybeSingle();
    if (o) {
      if (o.name) orgName = o.name;
      orgAddress = o.address;
      orgPhone = o.phone;
      orgEmail = o.email;
      if (o.logo_path) {
        orgLogoUrl = admin.storage
          .from("org-logos")
          .getPublicUrl(o.logo_path).data.publicUrl;
      }
      // Phase 3 gate — ALL THREE conditions. platformLiable fails closed
      // (matches isPlatformLiable in connectAccount.ts): any losses_owner that
      // isn't "stripe" means the platform is on the hook, so we refuse to
      // expose payment even if Stripe says charges_enabled. An account can be
      // fully chargeable at Stripe and still be one we refuse to use.
      const lossesOwner = (o.connect_losses_owner as string | null) ?? null;
      const platformLiable = lossesOwner !== "stripe";
      paymentsEnabled =
        isLawn() && !!o.connect_charges_enabled && !platformLiable;
    }
  }

  const jobRow = invoice.jobs as unknown as { name: string } | null;
  const custRow = invoice.customers as unknown as { name: string } | null;
  const customerName = custRow?.name ?? "—";
  const jobName = jobRow?.name ?? "—";

  const items = (lineItems ?? []).map((i) => ({
    id: i.id,
    description: i.description,
    quantity: Number(i.quantity),
    unitPrice: Number(i.unit_price),
  }));

  const total = computeTotal(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unitPrice }))
  );
  const amountPaid = Number(invoice.amount_paid ?? 0) || 0;
  const balanceDue = Math.max(0, total - amountPaid);

  const isPaid = invoice.status === "paid";
  const isVoid = invoice.status === "void";

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <InvoiceDocument
        orgName={orgName}
        orgAddress={orgAddress}
        orgPhone={orgPhone}
        orgEmail={orgEmail}
        orgLogoUrl={orgLogoUrl}
        customerName={customerName}
        jobName={jobName}
        status={invoice.status}
        sentAt={invoice.sent_at}
        dueDate={invoice.due_date}
        total={total}
        amountPaid={amountPaid}
        balanceDue={balanceDue}
        items={items}
      />
      <div className="max-w-md mx-auto px-4 pb-8">
        <InvoiceStatusBanner
          paid={isPaid}
          balanceDueStr={formatMoney(balanceDue)}
          isVoid={isVoid}
          paymentsEnabled={paymentsEnabled}
        />
        {paymentsEnabled && !isPaid && !isVoid && (
          <InvoicePayActions token={token} />
        )}
      </div>
    </div>
  );
}