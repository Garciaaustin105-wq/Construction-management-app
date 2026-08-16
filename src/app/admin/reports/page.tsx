import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import { FileSpreadsheet, Receipt, ChevronRight } from "lucide-react";
import { isLawn } from "@/lib/variant";

export const dynamic = "force-dynamic";

// Reports index — office/admin only. Lists the available report types. New
// report types are added here as cards (extensible). Each links to its own
// page with filters + export. RLS scopes every report to the caller's org.
export default async function ReportsIndexPage() {
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
  if (profile?.role !== "office" && profile?.role !== "admin") redirect("/dashboard");

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
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Reports" subtitle="Pull report data" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-3">
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
      </main>
    </div>
  );
}