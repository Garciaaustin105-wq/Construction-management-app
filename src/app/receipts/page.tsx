import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import BottomNav from "@/components/BottomNav";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import ReceiptsExportButton, {
  type ExportReceipt,
} from "@/components/ReceiptsExportButton";
import { formatMoney } from "@/lib/money";
import { Receipt as ReceiptIcon } from "lucide-react";
import Link from "next/link";

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
      "id, vendor, amount, notes, captured_at, uploaded_by_name, reimbursed, reimbursed_at, jobs(name)"
    )
    .order("captured_at", { ascending: false });

  type Row = {
    id: string;
    vendor: string | null;
    amount: number | null;
    notes: string | null;
    captured_at: string;
    uploaded_by_name: string | null;
    reimbursed: boolean;
    reimbursed_at: string | null;
    jobs: { name: string } | null;
  };

  const rows = (receipts ?? []) as unknown as Row[];

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

        {/* List */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-2">
            <ReceiptIcon className="w-4 h-4" />
            Shared Receipts
          </h2>
          {rows.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.Briefcase}
                title="No shared receipts"
                description="When crew share receipts from a job, they'll appear here with the project tag, vendor, and amount for your tax records."
              />
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {rows.map((r) => (
                <div key={r.id} className="p-3">
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">
                        {r.vendor ?? "No vendor"}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        <Link
                          href="/dashboard"
                          className="text-blue-600 hover:underline"
                        >
                          {r.jobs?.name ?? "—"}
                        </Link>
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {new Date(r.captured_at).toLocaleDateString()} ·{" "}
                        {r.uploaded_by_name ?? "—"}
                      </p>
                      {r.notes && (
                        <p className="text-xs text-gray-500 mt-1 truncate">
                          {r.notes}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-sm font-bold text-gray-900">
                        {formatMoney(r.amount ?? 0)}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${
                          r.reimbursed
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-orange-100 text-orange-700"
                        }`}
                      >
                        {r.reimbursed ? "Paid back" : "Owed"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <BottomNav />
    </div>
  );
}