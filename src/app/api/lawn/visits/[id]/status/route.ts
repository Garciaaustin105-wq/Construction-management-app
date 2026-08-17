import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import {
  sendCustomerNotification,
  buildPhotoLink,
  anySent,
} from "@/lib/customerNotifications";
import { buildStaticMapUrl } from "@/lib/staticMap";

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
    .select("id, status, due_date, notified_at, job_id, share_token, organization_id")
    .eq("id", id)
    .maybeSingle();
  const cur = current as unknown as {
    id: string;
    status: string;
    due_date: string;
    notified_at: string | null;
    job_id: string;
    share_token: string | null;
    organization_id: string | null;
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

  // ── Decide whether to notify the customer ──────────────────────────────────
  // The notification suite fires the service_complete event (with a before/after
  // photo-portal link) when the visit is marked done, followed immediately by a
  // review_request. Both are templated, opt-in gated, and logged via
  // notification_log. The one-shot gate (notified_at IS NULL) is preserved — at
  // most one notice per visit. notified_at is stamped AFTER the attempts
  // regardless of send success, so a transient Resend/Twilio failure does not
  // re-fire the notice on every subsequent action (done→reopen→done); the office
  // can resend a one-off from the visit page if a customer reports a miss.
  const statusBecameDone = body.status === "done" && cur.status !== "done";
  const shouldNotify = cur.notified_at === null && statusBecameDone;

  let notified = false;
  if (shouldNotify) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, address, organization_id, lawn_jobs(map_lat, map_lng)")
      .eq("id", cur.job_id)
      .maybeSingle();
    const jobRow = job as unknown as
      | {
          customer_id: string | null;
          name: string | null;
          address: string | null;
          organization_id: string | null;
          lawn_jobs: { map_lat: number | null; map_lng: number | null } | null;
        }
      | null;
    const customerId = jobRow?.customer_id ?? null;
    const organizationId = cur.organization_id ?? jobRow?.organization_id ?? null;

    if (customerId && organizationId) {
      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", organizationId)
        .maybeSingle();
      const orgName =
        (org as unknown as { name: string | null } | null)?.name ?? null;

      const photoLink = buildPhotoLink(cur.share_token);
      // Property map image for the email (Static Maps). null when the job has no
      // pin or GOOGLE_MAPS_STATIC_KEY is unset → email sends without the image.
      const pin = jobRow?.lawn_jobs;
      const mapImageUrl = buildStaticMapUrl(pin?.map_lat ?? null, pin?.map_lng ?? null);

      // service_complete (templated email + sms, opt-in gated, logged).
      const completeResults = await sendCustomerNotification({
        supabase,
        event: "service_complete",
        organizationId,
        visitId: id,
        customerId,
        jobName: jobRow?.name ?? null,
        address: jobRow?.address ?? null,
        serviceDate: cur.due_date,
        orgName,
        photoLink,
        mapImageUrl,
      });

      // review_request follows only if a review_request template is active AND
      // the org has configured a Google review URL — both checked inside the
      // helper (getTemplate returns null → skipped; buildReviewLink returns null
      // → the {{review_link}} token renders empty, but the office controls
      // whether the template is active at all).
      const reviewResults = await sendCustomerNotification({
        supabase,
        event: "review_request",
        organizationId,
        visitId: id,
        customerId,
        jobName: jobRow?.name ?? null,
        address: jobRow?.address ?? null,
        serviceDate: cur.due_date,
        orgName,
        mapImageUrl,
      });

      notified = anySent(completeResults) || anySent(reviewResults);
    }

    await supabase
      .from("lawn_visits")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", id);
  }

  return NextResponse.json({ ok: true, notified });
}