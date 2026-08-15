import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import EmptyState from "@/components/EmptyState";
import { OFFICE_LIKE } from "@/lib/roles";
import LawnCycleBillingButton from "@/components/LawnCycleBillingButton";
import { FileText, ArrowLeft } from "lucide-react";

// Lawn cycle billing preview. Shows each customer's done-but-unbilled lawn
// visits (count + total at price_per_visit) so the office can review before
// generating invoices. The Generate button calls the billing route, which
// creates one invoice per customer with one line per visit and marks the visits
// billed (invoice_id) so they're never double-invoiced.

type UnbilledVisit = {
  id: string;
  due_date: string;
  jobs: {
    id: string;
    name: string;
    customer_id: string | null;
    customers: { name: string | null } | null;
  } | null;
  recurring_schedules: {
    service_type: string | null;
    price_per_visit: number;
  } | null;
};

function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

export default async function LawnBillingPage() {
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
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const { data: rows } = await supabase
    .from("lawn_visits")
    .select(
      "id, due_date, jobs(id, name, customer_id, customers(name)), recurring_schedules(service_type, price_per_visit)"
    )
    .eq("status", "done")
    .is("invoice_id", null)
    .order("due_date", { ascending: true });
  const visits = (rows as unknown as UnbilledVisit[] | null) ?? [];

  // Group by customer; visits with no customer are flagged (can't be billed).
  type Group = {
    customerId: string;
    customerName: string | null;
    visits: UnbilledVisit[];
    total: number;
  };
  const byCustomer = new Map<string, Group>();
  let noCustomerCount = 0;
  for (const v of visits) {
    const cid = v.jobs?.customer_id ?? null;
    if (!cid) {
      noCustomerCount += 1;
      continue;
    }
    let g = byCustomer.get(cid);
    if (!g) {
      g = {
        customerId: cid,
        customerName: v.jobs?.customers?.name ?? null,
        visits: [],
        total: 0,
      };
      byCustomer.set(cid, g);
    }
    g.visits.push(v);
    g.total += Number(v.recurring_schedules?.price_per_visit ?? 0);
  }
  const groups = Array.from(byCustomer.values()).sort((a, b) =>
    (a.customerName ?? "~") < (b.customerName ?? "~") ? -1 : 1
  );
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);
  const totalVisits = visits.length;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Lawn Billing" subtitle="Monthly cycle invoicing" />

      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <Link
          href="/lawn"
          className="inline-flex items-center gap-1 text-sm text-green-700 font-semibold"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Lawn
        </Link>

        {totalVisits === 0 ? (
          <div className="bg-white rounded-lg">
            <EmptyState
              icon={FileText}
              title="Nothing to bill"
              description="Completed lawn visits awaiting invoice will appear here. Mark visits done from the route or visit page to make them billable."
            />
          </div>
        ) : (
          <>
            <div className="bg-white rounded-lg p-3 shadow-sm flex justify-between items-center">
              <div>
                <p className="text-xs text-gray-500">
                  {totalVisits} done visit{totalVisits === 1 ? "" : "s"} ·{" "}
                  {groups.length} customer{groups.length === 1 ? "" : "s"}
                </p>
                <p className="font-bold text-gray-900">{money(grandTotal)}</p>
              </div>
              <span className="text-[10px] font-semibold px-2 py-1 rounded bg-amber-100 text-amber-800">
                Unbilled
              </span>
            </div>

            {groups.map((g) => (
              <div key={g.customerId} className="bg-white rounded-lg p-3 shadow-sm space-y-2">
                <div className="flex justify-between items-start">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 truncate">
                      {g.customerName ?? "—"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {g.visits.length} visit{g.visits.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <p className="font-semibold text-gray-900 whitespace-nowrap">
                    {money(g.total)}
                  </p>
                </div>
                <ul className="text-xs text-gray-500 divide-y">
                  {g.visits.map((v) => (
                    <li key={v.id} className="py-1 flex justify-between gap-2">
                      <span className="truncate">
                        {v.recurring_schedules?.service_type ?? "Lawn service"} ·{" "}
                        {v.due_date}
                      </span>
                      <span className="whitespace-nowrap">
                        {money(Number(v.recurring_schedules?.price_per_visit ?? 0))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {noCustomerCount > 0 && (
              <p className="text-xs text-amber-700">
                {noCustomerCount} done visit{noCustomerCount === 1 ? "" : "s"}{" "}
                skipped — no customer on the job. Assign a customer to bill them.
              </p>
            )}

            <div className="pt-2">
              <LawnCycleBillingButton />
              <p className="text-[11px] text-gray-400 text-center mt-2">
                Creates one invoice per customer with a line per visit; visits are
                marked billed so they won&rsquo;t be invoiced again.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}