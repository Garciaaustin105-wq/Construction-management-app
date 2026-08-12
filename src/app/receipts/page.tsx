import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import ReceiptsExportButton, {
  type ExportReceipt,
} from "@/components/ReceiptsExportButton";
import OfficeReceiptsList, {
  type ReceiptRow,
} from "@/components/OfficeReceiptsList";
import { formatMoney } from "@/lib/money";

export default async function ReceiptsOverviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if ((profile?.role ?? "crew") !== "office") redirect("/dashboard");

  // All shared receipts across jobs, with the project (job) tag for tax records.
  const { data: receipts } = await supabase
    .from("receipts")
    .select(
      "id, storage_path, vendor, amount, notes, captured_at, uploaded_by_name, reimbursed, reimbursed_at, category, tax, payment_method, receipt_no, jobs(name)"
    )
    .order("captured_at", { ascending: false });

  const rows = (receipts ?? []) as unknown as ReceiptRow[];

  const exportRows: ExportReceipt[] = rows.map((r) => ({
    id: r.id,
    jobName: r.jobs?.name ?? "—",
    vendor: r.vendor,
    amount: r.amount,
    capturedAt: r.captured_at,
    uploader: r.uploaded_by_name,
    reimbursed: r.reimbursed,
    reimbursedAt: r.reimbursed_at,
    notes: r.notes,
    category: r.category,
    tax: r.tax,
    paymentMethod: r.payment_method,
    receiptNo: r.receipt_no,
  }));

  const totalAmount = rows.reduce(
    (sum, r) => sum + (r.amount ?? 0),
    0
  );
  const owedAmount = rows
    .filter((r) => !r.reimbursed)
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const reimbursedAmount = rows
    .filter((r) => r.reimbursed)
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const owedCount = rows.filter((r) => !r.reimbursed).length;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Receipts" subtitle="All shared expense receipts" />

      <main className="max-w-md mx-auto p-4 space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-white rounded-lg p-3 shadow-sm text-center">
            <p className="text-[10px] uppercase font-semibold text-gray-500">
              Total
            </p>
            <p className="text-sm font-bold text-gray-900 mt-0.5">
              {formatMoney(totalAmount)}
            </p>
            <p className="text-[10px] text-gray-400">{rows.length} receipts</p>
          </div>
          <div className="bg-orange-50 rounded-lg p-3 text-center">
            <p className="text-[10px] uppercase font-semibold text-orange-600">
              Owed
            </p>
            <p className="text-sm font-bold text-orange-700 mt-0.5">
              {formatMoney(owedAmount)}
            </p>
            <p className="text-[10px] text-orange-500">{owedCount} unpaid</p>
          </div>
          <div className="bg-emerald-50 rounded-lg p-3 text-center">
            <p className="text-[10px] uppercase font-semibold text-emerald-600">
              Paid back
            </p>
            <p className="text-sm font-bold text-emerald-700 mt-0.5">
              {formatMoney(reimbursedAmount)}
            </p>
            <p className="text-[10px] text-emerald-500">
              {rows.length - owedCount} settled
            </p>
          </div>
        </div>

        <ReceiptsExportButton rows={exportRows} />

        {rows.length === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={EmptyIcons.Briefcase}
              title="No shared receipts"
              description="When crew share receipts from a job, they'll appear here with the project tag, vendor, and amount for your tax records."
            />
          </div>
        ) : (
          <OfficeReceiptsList rows={rows} />
        )}
      </main>

    </div>
  );
}