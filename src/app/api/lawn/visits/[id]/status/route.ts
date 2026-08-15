import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import { sendLawnVisitEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

// Central status / move handler for a lawn visit. Office/PM only. Accepts
// { status?, due_date? } and applies both. completed_at is set to now() when
// status==='done', null otherwise. After a SUCCESSFUL update it decides whether
// to email the customer a one-shot notice:
//   - notify when status becomes 'done' or 'skipped' (i.e. a real transition,
//     not a re-mark of an already-terminal state), OR
//   - notify when due_date changed (a move).
// Reopen (status 'pending' from done/skipped) never emails.
// The notice is gated by notified_at IS NULL — at most one per visit. notified_at
// is stamped AFTER the send attempt regardless of success, so a transient Resend
// failure does not spam a retry on every subsequent action (see comment below).

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body: { status?: string; due_date?: string } = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.status === "string") body.status = parsed.status;
      if (typeof parsed.due_date === "string") body.due_date = parsed.due_date;
    }
  } catch {
    // Empty / invalid body is treated as no-op fields.
  }

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

  // Snapshot the current row so we can detect a real transition + the
  // notified_at gate before mutating.
  const { data: current } = await supabase
    .from("lawn_visits")
    .select("id, status, due_date, notified_at, job_id")
    .eq("id", id)
    .maybeSingle();
  const cur = current as unknown as {
    id: string;
    status: string;
    due_date: string;
    notified_at: string | null;
    job_id: string;
  } | null;
  if (!cur) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }

  const patch: Record<string, unknown> = {};
  if (body.status) patch.status = body.status;
  if (body.status === "done") patch.completed_at = new Date().toISOString();
  else if (body.status) patch.completed_at = null;
  if (body.due_date) patch.due_date = body.due_date;
  // A move (due_date change) invalidates the dispatcher's saved per-crew
  // sequence for the old day — null route_order so it doesn't collide with the
  // target day's existing order in My Route (review MEDIUM-2). The dispatcher
  // re-plans the target day; until then moved visits sort after planned ones.
  if (body.due_date && body.due_date !== cur.due_date) patch.route_order = null;

  const { error: updateError } = await supabase
    .from("lawn_visits")
    .update(patch)
    .eq("id", id);

  if (updateError) {
    // 23505 = unique (recurring_schedule_id, due_date) violation on a move.
    if (updateError.code === "23505") {
      return NextResponse.json(
        {
          ok: false,
          error: "A visit already exists on that date for this schedule",
          code: "23505",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: updateError.message },
      { status: 500 }
    );
  }

  // ── Decide whether to email a notice ────────────────────────────────────
  const statusBecameTerminal =
    !!body.status &&
    (body.status === "done" || body.status === "skipped") &&
    cur.status !== body.status;
  const dueDateChanged = !!body.due_date && body.due_date !== cur.due_date;
  const shouldNotify =
    cur.notified_at === null && (statusBecameTerminal || dueDateChanged);

  let notified = false;
  if (shouldNotify) {
    // Resolve customer email: job → customers.email, fall back to portal
    // profile email (profiles.email where customer_id = …).
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, address")
      .eq("id", cur.job_id)
      .maybeSingle();
    const jobRow = job as unknown as
      | {
          customer_id: string | null;
          name: string | null;
          address: string | null;
        }
      | null;
    const jobName = jobRow?.name ?? "your property";
    const address = jobRow?.address ?? null;
    const customerId = jobRow?.customer_id ?? null;

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

    if (customerEmail) {
      // Pick subject + body lines from what changed.
      let subject: string;
      const lines: string[] = [];
      if (statusBecameTerminal) {
        subject =
          body.status === "done"
            ? `Lawn service completed — ${jobName}`
            : `Lawn service skipped — ${jobName}`;
        lines.push(
          body.status === "done"
            ? `Your lawn service for ${jobName} has been marked complete.`
            : `Today's lawn service for ${jobName} was skipped.`
        );
      } else {
        subject = `Lawn service rescheduled — ${jobName}`;
        lines.push(
          `Your lawn service for ${jobName} has been moved to ${body.due_date}.`
        );
      }

      // Send is non-fatal — a Resend failure must not throw here.
      try {
        await sendLawnVisitEmail({
          to: customerEmail,
          customerName: customerName ?? "",
          jobName,
          address,
          subject,
          lines,
        });
      } catch {
        // Swallow — see notified_at note below.
      }
      notified = true;
    }

    // Stamp notified_at AFTER the attempt, regardless of send success. Rationale:
    // a transient Resend outage would otherwise re-fire the notice on every
    // subsequent action (done→reopen→done, or another move). One notice per visit
    // is the intended UX; the office can always resend a one-off from the visit
    // page if a customer reports they didn't get it.
    await supabase
      .from("lawn_visits")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", id);
  }

  return NextResponse.json({ ok: true, notified });
}