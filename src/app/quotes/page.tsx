import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import BottomNav from "@/components/BottomNav";
import ClientPullToRefresh from "@/components/ClientPullToRefresh";
import EmptyState, { EmptyIcons } from "@/components/EmptyState";
import StatusBadge from "@/components/StatusBadge";
import { formatMoney, computeTotal } from "@/components/LineItemEditor";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
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
  if (role !== "office") redirect("/dashboard");

  const statusFilter = params.status ?? "all";

  let query = supabase
    .from("quotes")
    .select(
      "id, status, total_amount:quote_line_items(quantity, unit_price), jobs(name), customers(name), created_at, sent_at"
    )
    .order("created_at", { ascending: false });

  if (statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data: quotes } = await query;

  // Aggregate line items for total. Supabase returns the joined rows as an array.
  const quotesWithTotals = (quotes ?? []).map((q) => {
    const items = (q.total_amount as unknown as { quantity: number; unit_price: number }[]) ?? [];
    return {
      id: q.id,
      status: q.status,
      jobName: (q.jobs as unknown as { name: string } | null)?.name ?? "—",
      customerName: (q.customers as unknown as { name: string } | null)?.name ?? "—",
      createdAt: q.created_at,
      sentAt: q.sent_at,
      total: computeTotal(items),
    };
  });

  const filterOptions: { value: string; label: string }[] = [
    { value: "all", label: "All" },
    { value: "draft", label: "Draft" },
    { value: "sent", label: "Sent" },
    { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
  ];

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Quotes" subtitle={`${quotesWithTotals.length} total`} />

      <main className="max-w-md mx-auto p-4 space-y-4">
        <Link
          href="/quotes/new"
          className="block bg-blue-600 text-white text-center py-3 rounded-lg font-semibold active:bg-blue-700 flex items-center justify-center gap-2"
        >
          <Plus className="w-5 h-5" />
          New Quote
        </Link>

        <div className="flex gap-2 overflow-x-auto -mx-4 px-4">
          {filterOptions.map((opt) => (
            <Link
              key={opt.value}
              href={`/quotes?status=${opt.value}`}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium ${
                statusFilter === opt.value
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-700 border border-gray-200"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        <ClientPullToRefresh>
          {quotesWithTotals.length === 0 ? (
            <div className="bg-white rounded-lg">
              <EmptyState
                icon={EmptyIcons.FileText}
                title="No quotes yet"
                description="Tap “New Quote” above to send a price to a customer."
              />
            </div>
          ) : (
            <div className="space-y-2">
              {quotesWithTotals.map((q) => (
                <Link
                  key={q.id}
                  href={`/quotes/${q.id}`}
                  className="block bg-white rounded-lg p-4 shadow-sm active:bg-gray-50"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900 truncate">
                        {q.jobName}
                      </p>
                      <p className="text-sm text-gray-500 truncate">
                        {q.customerName}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(q.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <StatusBadge status={q.status} />
                      <span className="text-sm font-bold text-gray-900">
                        {formatMoney(q.total)}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </ClientPullToRefresh>
      </main>

      <BottomNav />
    </div>
  );
}