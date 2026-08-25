import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect, notFound } from "next/navigation";
import TopBar from "@/components/TopBar";
import CustomerDetail, {
  type CustomerDetailRow,
  type CustomerJob,
  type CustomerSub,
} from "@/components/CustomerDetail";
import { MANAGEMENT, type Role } from "@/lib/roles";
import { isLawn } from "@/lib/variant";

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
  // A customer's "jobs" differ by variant: construction → construction-type job
  // records (linked to /jobs/[id]); lawn → recurring schedules (the lawn
  // job-detail surface is /lawn/schedules/[id] — the construction /jobs/[id]
  // route is blocked in the lawn variant by proxy.ts and bounces to /lawn, so
  // linking there from a customer's jobs tab would dump the user on home).
  const lawn = isLawn();
  const [{ data: cust }, { data: jobRows }] = await Promise.all([
    supabase
      .from("customers")
      .select(
        "id, name, contact_name, contact_email, phone, address, notes, sms_opt_in, email_opt_in"
      )
      .eq("id", id)
      .single(),
    lawn
      ? supabase
          .from("jobs")
          .select("id, name")
          .eq("type", "lawn")
          .eq("customer_id", id)
          .order("name")
      : supabase
          .from("jobs")
          .select("id, name, status")
          .eq("type", "construction")
          .eq("customer_id", id)
          .order("name"),
  ]);
  if (!cust) notFound();

  let jobs: CustomerJob[];
  let jobIds: string[] = [];
  if (lawn) {
    // Map the customer's lawn jobs to their recurring schedules, carrying the
    // SCHEDULE id (the link target). Two queries rather than an embed filter —
    // this project has hit PGRST108 on un-declared-FK embeds before, and a
    // direct customer_id + .in(job_id) is reliable.
    const lawnJobIds = (jobRows ?? []).map((j) => (j as { id: string }).id);
    const { data: schedRows } = await supabase
      .from("recurring_schedules")
      .select("id, active, job_id")
      .in("job_id", lawnJobIds);
    const byJob = new Map<string, { id: string; active: boolean }[]>();
    for (const s of (schedRows ?? []) as { id: string; active: boolean; job_id: string }[]) {
      const arr = byJob.get(s.job_id) ?? [];
      arr.push({ id: s.id, active: s.active });
      byJob.set(s.job_id, arr);
    }
    jobs = (jobRows ?? []).flatMap((j) => {
      const jr = j as { id: string; name: string };
      return (byJob.get(jr.id) ?? []).map((s) => ({
        id: s.id,
        name: jr.name,
        status: s.active ? "Active" : "Paused",
      }));
    });
  } else {
    jobs = (jobRows ?? []) as CustomerJob[];
    jobIds = jobs.map((j) => j.id);
  }

  // Subcontractors attached to this customer's jobs.
  // job_subcontractors -> subcontractor + job name. We pull for the jobs above.
  // Construction only — the Subs tab is hidden in lawn (CustomerDetail), and in
  // lawn `jobs` carries schedule ids, not job ids, so jobIds stays [] there.
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

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Customer" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <CustomerDetail
          customer={cust as unknown as CustomerDetailRow}
          jobs={jobs}
          subs={subs}
          canEdit={role === "office" || role === "admin"}
        />
      </main>
    </div>
  );
}