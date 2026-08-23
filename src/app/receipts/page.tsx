import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import Link from "next/link";
import PageContainer from "@/components/PageContainer";
import { FIELD_MGMT, type Role } from "@/lib/roles";
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
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role as Role;
  // Admit office / admin / super_admin — the same set BottomNav shows the
  // Receipts tab to. Gating on role === "office" alone bounced admin and
  // super_admin back to /dashboard when they tapped the tab (looked like the
  // page just refreshed / sent them home). RLS already returns rows for all
  // three via tier_office (is_office = office/admin, plus super_admin).
  // Admit field-management (superintendent + PM + office + admin/super_admin)
  // so a PM running job cost can review receipts. Was OFFICE_LIKE, which bounced
  // PM. RLS returns rows via tier_office / tier_office_or_pm.
  if (!FIELD_MGMT.has(role)) redirect("/dashboard");

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
    <PageContainer title="Receipts" subtitle="All shared expense receipts" maxWidth="list">
      {rows.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line shadow-sm">
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
    </PageContainer>
  );
}