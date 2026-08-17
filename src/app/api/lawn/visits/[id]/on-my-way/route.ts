import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import { sendCustomerNotification, anySent } from "@/lib/customerNotifications";

export const dynamic = "force-dynamic";

// One-tap "your crew is on the way" notice to the job's customer. Reachable
// from the visit page. The caller must be office/admin/PM (OFFICE_OR_PM).
// Sends the on_my_way notification (templated, opt-in gated, both email+sms
// attempted, logged) via the notification suite. Each tap sends — there is no
// one-shot gate, as before. A customer with no contact on file / opted out /
// notifications disabled resolves to a soft skip (200 { ok:false, reason }),
// never a 500; the senders themselves never throw.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = profile?.role ?? null;
  if (!role || !OFFICE_OR_PM.has(role as never)) {
    return NextResponse.json({ error: "Office or PM only" }, { status: 403 });
  }

  // Visit → job → customer.
  const { data: visit } = await supabase
    .from("lawn_visits")
    .select("job_id, organization_id")
    .eq("id", id)
    .maybeSingle();
  const visitRow = visit as unknown as
    | { job_id: string | null; organization_id: string | null }
    | null;
  const jobId = visitRow?.job_id;
  if (!jobId) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("customer_id, name, address, organization_id")
    .eq("id", jobId)
    .maybeSingle();
  const jobRow = job as unknown as
    | {
        customer_id: string | null;
        name: string | null;
        address: string | null;
        organization_id: string | null;
      }
    | null;
  if (!jobRow) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const customerId = jobRow.customer_id ?? null;
  const organizationId = visitRow?.organization_id ?? jobRow.organization_id ?? null;

  if (!customerId || !organizationId) {
    // No customer to notify (e.g. an internal/yard job) — soft skip.
    return NextResponse.json({ ok: false, reason: "no customer" });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .maybeSingle();
  const orgName =
    (org as unknown as { name: string | null } | null)?.name ?? null;

  // sendCustomerNotification resolves the customer contact + name + opt-ins,
  // applies the gate chain, renders the on_my_way template, sends email+sms,
  // and logs. Never throws. anySent → at least one channel delivered.
  const results = await sendCustomerNotification({
    supabase,
    event: "on_my_way",
    organizationId,
    visitId: id,
    customerId,
    jobName: jobRow.name ?? null,
    address: jobRow.address ?? null,
    orgName,
  });

  if (anySent(results)) {
    return NextResponse.json({ ok: true });
  }

  // Soft skip reasons (opted out / no contact / notifications disabled /
  // template inactive). Surface a short reason so the client can toast the
  // right message without erroring.
  const reason =
    results.find((r) => r.reason)?.reason ?? "not sent";
  return NextResponse.json({ ok: false, reason });
}