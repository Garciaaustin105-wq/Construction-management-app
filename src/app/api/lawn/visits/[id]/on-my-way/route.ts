import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import { sendOnMyWayEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// One-tap "your crew is on the way" email to the job's customer. Reachable from
// the visit page. The caller must be office/admin/PM (OFFICE_OR_PM). Customer
// email is resolved job → customers.email, falling back to the portal profile
// email (profiles.email where customer_id = …). A missing email is NON-FATAL —
// the route returns 200 { ok:false, reason:"no email" } so the client can toast
// "No email on file" without erroring. The Resend send itself is also
// non-fatal (sendOnMyWayEmail never throws).

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
    .select("job_id")
    .eq("id", id)
    .maybeSingle();
  const jobId = (visit as unknown as { job_id: string | null } | null)?.job_id;
  if (!jobId) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("customer_id, name, address")
    .eq("id", jobId)
    .maybeSingle();
  const jobRow = job as unknown as
    | { customer_id: string | null; name: string | null; address: string | null }
    | null;
  if (!jobRow) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const jobName = jobRow.name ?? "your property";
  const address = jobRow.address ?? null;
  const customerId = jobRow.customer_id ?? null;

  let customerEmail: string | null = null;
  let customerName: string | null = null;

  if (customerId) {
    const { data: customer } = await supabase
      .from("customers")
      .select("contact_email, name")
      .eq("id", customerId)
      .maybeSingle();
    const c = customer as unknown as
      | { contact_email: string | null; name: string | null }
      | null;
    customerName = c?.name ?? null;
    customerEmail = c?.contact_email?.trim() || null;

    // Fall back to the portal profile email if the customer row has no email.
    if (!customerEmail) {
      const { data: portalProfile } = await supabase
        .from("profiles")
        .select("email")
        .eq("customer_id", customerId)
        .limit(1)
        .maybeSingle();
      const p = portalProfile as unknown as { email: string | null } | null;
      customerEmail = p?.email?.trim() || null;
    }
  }

  if (!customerEmail) {
    // Non-fatal — no email on file is a soft skip, not an error.
    return NextResponse.json({ ok: false, reason: "no email" });
  }

  try {
    const { error } = await sendOnMyWayEmail({
      to: customerEmail,
      customerName: customerName ?? "",
      jobName,
      address,
    });
    if (error) {
      // Distinguish "not configured" so the client can toast the right message.
      if (error.message === "email not configured") {
        return NextResponse.json({ ok: false, reason: "not configured" });
      }
      return NextResponse.json({ ok: false, error: error.message });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "email failed" },
      { status: 502 }
    );
  }
}