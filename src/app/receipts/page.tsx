import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import { OFFICE_LIKE } from "@/lib/roles";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import OfficeReceiptsList, {
  type ReceiptRow,
} from "@/components/OfficeReceiptsList";

const PAGE_SIZE = 50;

export default async function ReceiptsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
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
  const role = profile?.role ?? "crew";
  // Admit office / admin / super_admin — the same set BottomNav shows the
  // Receipts tab to. Gating on role === "office" alone bounced admin and
  // super_admin back to /dashboard when they tapped the tab (looked like the
  // page just refreshed / sent them home). RLS already returns rows for all
  // three via tier_office (is_office = office/admin, plus super_admin).
  if (!OFFICE_LIKE.has(role)) redirect("/dashboard");

  const sp = await searchParams;
  const offset = Math.max(0, Number(sp.offset ?? "0") || 0);

  // Shared receipts across jobs, paged 50 at a time via ?offset= so the office
  // doesn't pull the entire table (and its signed thumbnails) on first load.
  // uploaded_by + uploaded_by_name drive the uploader filter; uploaded_by_name
  // is denormalized because profiles RLS only lets a user read their own profile.
  const { data: receipts } = await supabase
    .from("receipts")
    .select(
      "id, storage_path, uploaded_by, vendor, amount, notes, captured_at, uploaded_by_name, reimbursed, reimbursed_at, category, tax, payment_method, receipt_no, jobs(name)"
    )
    .order("captured_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const rows = (receipts ?? []) as unknown as ReceiptRow[];
  const hasMore = rows.length === PAGE_SIZE;

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
          <>
            <OfficeReceiptsList rows={rows} />
            {hasMore && (
              <div className="text-center pt-1">
                <Link
                  href={`/receipts?offset=${offset + PAGE_SIZE}`}
                  className="inline-block text-sm text-blue-600 font-medium"
                >
                  Load more →
                </Link>
              </div>
            )}
          </>
        )}
      </main>

    </div>
  );
}