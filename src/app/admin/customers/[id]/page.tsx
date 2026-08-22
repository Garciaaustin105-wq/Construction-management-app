import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect, notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import CustomerDetail, {
  type CustomerDetailRow,
  type CustomerJob,
  type CustomerSub,
} from "@/components/CustomerDetail";
import IspCustomerPanel from "@/components/IspCustomerPanel";
import { MANAGEMENT, type Role } from "@/lib/roles";
import { isIspOrg } from "@/lib/ispModule";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role as Role;
  if (!MANAGEMENT.has(role)) redirect("/dashboard");

  // Customer + jobs are independent reads (both only need `id`) — fan them
  // out together instead of awaiting one after the other. This was the
  // biggest chunk of "customer file is slow to react": opening a customer
  // paid for these two round trips back-to-back when neither depends on the
  // other. Subs still has to wait on jobs (it needs the resolved job ids).
  const [{ data: cust }, { data: jobRows }] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, name, contact_name, contact_email, phone, address, service_plan, notes, sms_opt_in, email_opt_in"
      )
      .eq("id", id)
      .single(),
    supabase
      .from("jobs")
      .select("id, name, status")
      .eq("type", "construction")
      .eq("customer_id", id)
      .order("name"),
  ]);
  if (!cust) notFound();
  const jobs: CustomerJob[] = (jobRows ?? []) as CustomerJob[];

  // Subcontractors attached to this customer's jobs.
  // job_subcontractors -> subcontractor + job name. We pull for the jobs above.
  const jobIds = jobs.map((j) => j.id);
  const subs: CustomerSub[] = [];
  if (jobIds.length > 0) {
    const { data: linked } = await supabase
      .from("job_subcontractors")
      .select(
        "job_id, subcontractor:subcontractors(id, company, trade, phone, email), job:jobs(name)"
      )
      .in("job_id", jobIds);
    const rows = (linked ?? []) as unknown as {
      job_id: string;
      subcontractor: {
        id: string;
        company: string;
        trade: string | null;
        phone: string | null;
        email: string | null;
      } | null;
      job: { name: string | null } | null;
    }[];
    // Dedupe by sub id, keeping the first job name encountered.
    const seen = new Set<string>();
    for (const r of rows) {
      const s = r.subcontractor;
      if (!s) continue;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      subs.push({
        id: s.id,
        company: s.company,
        trade: s.trade,
        phone: s.phone,
        email: s.email,
        job_name: r.job?.name ?? "—",
      });
    }
  }

  // ISP/fiber module: the "Internet" tab only exists for orgs that have it.
  // Passing undefined (rather than a component that renders nothing) is what
  // keeps the tab itself out of the tab bar for every other tenant.
  const showIsp = await isIspOrg(me.orgId);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Customer" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <CustomerDetail
          customer={cust as unknown as CustomerDetailRow}
          jobs={jobs}
          subs={subs}
          canEdit={role === "office" || role === "admin"}
          ispPanel={
            showIsp && me.orgId ? (
              <IspCustomerPanel customerId={id} orgId={me.orgId} />
            ) : undefined
          }
        />
      </main>
    </div>
  );
}