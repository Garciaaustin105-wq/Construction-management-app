import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import OfficeReceiptsList, {
  type ReceiptRow,
} from "@/components/OfficeReceiptsList";

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
  // uploaded_by + uploaded_by_name drive the uploader filter; uploaded_by_name is
  // denormalized because profiles RLS only lets a user read their own profile.
  const { data: receipts } = await supabase
    .from("receipts")
    .select(
      "id, storage_path, uploaded_by, vendor, amount, notes, captured_at, uploaded_by_name, reimbursed, reimbursed_at, category, tax, payment_method, receipt_no, jobs(name)"
    )
    .order("captured_at", { ascending: false });

  const rows = (receipts ?? []) as unknown as ReceiptRow[];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Receipts" subtitle="All shared expense receipts" />

      <main className="max-w-md mx-auto p-4 space-y-4">
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