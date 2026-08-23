import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import Link from "next/link";
import { FileSpreadsheet, Receipt, ChevronRight } from "lucide-react";
import { isLawn } from "@/lib/variant";
import { OFFICE_OR_PM, ACCOUNTING } from "@/lib/roles";

export const dynamic = "force-dynamic";

// Reports index — office/PM (office/admin/super_admin/project_manager). Lists
// the available report types. New report types are added here as cards
// (extensible). Each links to its own page with filters + export. RLS scopes
// every report to the caller's org (time_entries + receipts office policies
// admit PM via tier_office_or_pm — see pm_reports_rls.sql).
export default async function ReportsIndexPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  // Admit office/admin/PM/super_admin + accountant (read-only financials).
  if (
    !(
      OFFICE_OR_PM.has((me.role) as never) ||
      ACCOUNTING.has((me.role) as never)
    )
  )
    redirect("/dashboard");

  const reports = [
    {
      href: "/admin/reports/weekly",
      icon: FileSpreadsheet,
      title: "Per-Worker Report",
      desc: "Hours, receipts, and payments per worker for a date range. Excel export.",
    },
    // Receipts are a construction-only surface (material receipts with photos /
    // cost codes). Lawn orgs have no receipts, so hide the card in the lawn
    // variant; the URL is also blocked by the variant proxy as defense-in-depth.
    ...(isLawn()
      ? []
      : [
          {
            href: "/admin/reports/receipts",
            icon: Receipt,
            title: "Receipts Report",
            desc: "Itemized receipts with photos, location, and paid/owed status. Excel + PDF export.",
          },
        ]),
  ];

  return (
    <PageContainer title="Reports" subtitle="Pull report data" maxWidth="list" mainClassName="space-y-3">
      {reports.map((r) => (
        <Link
          key={r.href}
          href={r.href}
          className="block bg-white rounded-lg p-4 shadow-sm active:bg-gray-50"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
              <r.icon className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-gray-900">{r.title}</p>
              <p className="text-xs text-gray-500 mt-0.5">{r.desc}</p>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 flex-shrink-0" />
          </div>
        </Link>
      ))}
    </PageContainer>
  );
}