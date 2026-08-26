import { createClient } from "@/lib/supabase/server";
import { getMeIdentity } from "@/lib/tenant";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { OFFICE_OR_PM } from "@/lib/roles";
import {
  sendCustomerNotification,
  buildPhotoLink,
  anySent,
} from "@/lib/customerNotifications";
import { buildStaticMapUrl } from "@/lib/staticMap";
import { effectiveStatus, type OrgBilling } from "@/lib/billing";
import { publicBaseUrl } from "@/lib/invoiceSend";

export const dynamic = "force-dynamic";

// Central status / move handler for a lawn visit. Office/PM, or crew/
// superintendent on their OWN visit (a due_date move stays office/PM-only).
// Accepts { status?, due_date?, skip_reason? } and applies all three.
// completed_at is set to now() when status==='done', null otherwise.
// skip_reason is set (trimmed, "" -> null) when status==='skipped' and cleared
// when reopening to 'pending' — a status-only field, not gated separately from
// the existing status auth (crew may supply it on their own visit same as
// they can already set status='skipped'). After a SUCCESSFUL update it decides
// whether to email the customer a one-shot notice:
//   - status becomes 'done'    → service_complete + review_request (gated by
//     notified_at IS NULL);
//   - status becomes 'skipped' → service_skipped (gated by notified_skipped_at
//     IS NULL — an INDEPENDENT one-shot so a done-notice and a skip-notice on
//     the same visit don't suppress each other).
// Reopen (status 'pending' from done/skipped) and a due_date move never email.
// Each flag is stamped AFTER the send attempt regardless of success (and even
// when there is no customer to notify), so a transient Resend failure or a
// no-customer visit doesn't re-fire on every subsequent action.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body: { status?: string; due_date?: string; skip_reason?: string } = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.status === "string") body.status = parsed.status;
      if (typeof parsed.due_date === "string") body.due_date = parsed.due_date;
      if (typeof parsed.skip_reason === "string")
        body.skip_reason = parsed.skip_reason;
    }
  } catch {
    // Empty / invalid body is treated as no-op fields.
  }

  const supabase = await createClient();
  const me = await getMeIdentity();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const user = me.user;

  const role = (me.hasProfile ? me.role : null);
  const officeLike = !!role && OFFICE_OR_PM.has(role as never);
  // Crew / superintendent may advance a visit's status (done / skipped /
  // reopen) so the customer notification suite fires when the CREW marks a
  // visit done — not only when office does. Rescheduling (a due_date move)
  // stays office/PM-only; crew cannot move a visit to a new day.
  const crewLike = role === "crew" || role === "superintendent";
  if (!officeLike && !crewLike) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  if (body.due_date && !officeLike) {
    return NextResponse.json(
      { error: "Only office or PM can reschedule a visit" },
      { status: 403 }
    );
  }

  // Snapshot the current row so we can detect a real transition + the
  // notified_at gate before mutating. crew_id is included so we can enforce
  // server-side that a crew/superintendent caller only acts on their own visit.
  const { data: current } = await supabase
    .from("lawn_visits")
    .select("id, status, due_date, notified_at, notified_skipped_at, job_id, share_token, organization_id, crew_id")
    .eq("id", id)
    .maybeSingle();
  const cur = current as unknown as {
    id: string;
    status: string;
    due_date: string;
    notified_at: string | null;
    notified_skipped_at: string | null;
    job_id: string;
    share_token: string | null;
    organization_id: string | null;
    crew_id: string | null;
  } | null;
  if (!cur) {
    return NextResponse.json({ error: "Visit not found" }, { status: 404 });
  }
  // Defense in depth: a crew/superintendent caller may only act on a visit
  // assigned to them (the page also checks this client-side). Office/PM
  // oversee every org visit via RLS (tier_office_or_pm).
  if (crewLike && cur.crew_id !== user.id) {
    return NextResponse.json({ error: "Not your visit" }, { status: 403 });
  }

  const patch: Record<string, unknown> = {};
  if (body.status) patch.status = body.status;
  if (body.status === "done") patch.completed_at = new Date().toISOString();
  else if (body.status) patch.completed_at = null;
  // skip_reason rides the same status transition — set (trimmed empty -> null)
  // when skipping, cleared automatically when reopening to pending. Not
  // touched on a plain due_date move or a transition to 'done'.
  const skipReason =
    body.status === "skipped" ? body.skip_reason?.trim() || null : null;
  if (body.status === "skipped") patch.skip_reason = skipReason;
  else if (body.status === "pending") patch.skip_reason = null;
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
  // Two INDEPENDENT one-shot notice paths, each gated by its own flag so neither
  // suppresses the other on the same visit:
  //   - done    → service_complete (+ review_request), gated by notified_at IS NULL;
  //   - skipped → service_skipped, gated by notified_skipped_at IS NULL.
  // Both are templated, opt-in gated, and logged via notification_log. Each flag
  // is stamped AFTER the attempts regardless of send success (and even when
  // there is no customer to notify), so a transient Resend/Twilio failure or a
  // no-customer visit doesn't re-fire on every subsequent action; the office can
  // resend a one-off from the visit page if a customer reports a miss.
  const statusBecameDone = body.status === "done" && cur.status !== "done";
  const statusBecameSkipped = body.status === "skipped" && cur.status !== "skipped";
  const shouldNotifyDone = cur.notified_at === null && statusBecameDone;
  const shouldNotifySkipped = cur.notified_skipped_at === null && statusBecameSkipped;

  let notified = false;
  if (shouldNotifyDone || shouldNotifySkipped) {
    // The notification reads (jobs / customers / templates / settings) + the
    // notification_log writes + the flag stamp run as the SERVICE ROLE so they
    // succeed regardless of who marked the visit — a crew caller's session
    // client may not be able to read the job/org or write notification_log, and
    // the crew update policy may not permit a flag write. The visit status
    // UPDATE above already ran on the RLS session client, so crew could only
    // touch their own visit; this block only reads + notifies + stamps. (The
    // morning remind cron already passes an admin client to
    // sendCustomerNotification the same way.)
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: job } = await admin
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
      const { data: org } = await admin
        .from("organizations")
        .select("name, plan, plan_status, trial_ends_at")
        .eq("id", organizationId)
        .maybeSingle();
      const orgRow = org as unknown as {
        name: string | null;
        plan: string | null;
        plan_status: string | null;
        trial_ends_at: string | null;
      } | null;
      const orgName = orgRow?.name ?? null;

      if (shouldNotifyDone) {
        const photoLink = buildPhotoLink(cur.share_token);
        // Property map image for the email (Static Maps). null when the job has
        // no pin or GOOGLE_MAPS_STATIC_KEY is unset → email sends without it.
        const pin = jobRow?.lawn_jobs;
        const mapImageUrl = buildStaticMapUrl(pin?.map_lat ?? null, pin?.map_lng ?? null);

        // Re-entry advisory (audit §4.2): if any application logged on this
        // visit carries a re-entry interval still in the future, tell the
        // customer to keep off the lawn until the latest one expires. Empty
        // when none (no restricted application, or the interval already lapsed)
        // — the {{re_entry_notice}} token renders away. The caller builds the
        // full sentence because the template engine has no conditionals.
        let reEntryNotice = "";
        {
          const { data: apps } = await admin
            .from("chemical_applications")
            .select("re_entry_until")
            .eq("visit_id", id)
            .not("re_entry_until", "is", null);
          const untils = (
            (apps as { re_entry_until: string | null }[] | null) ?? []
          )
            .map((a) => new Date(a.re_entry_until as string).getTime())
            .filter((t) => Number.isFinite(t));
          if (untils.length) {
            const max = new Date(Math.max(...untils));
            if (max.getTime() > Date.now()) {
              reEntryNotice = `Please keep people and pets off the lawn until ${max.toLocaleString(
                undefined,
                { dateStyle: "medium", timeStyle: "short" }
              )}.`;
            }
          }
        }

        // service_complete (templated email + sms, opt-in gated, logged).
        const completeResults = await sendCustomerNotification({
          supabase: admin,
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
          reEntryNotice,
        });

        // review_request follows only if a review_request template is active
        // AND the org has configured a Google review URL — both checked inside
        // the helper (getTemplate returns null → skipped; buildReviewLink
        // returns null → {{review_link}} renders empty, but the office controls
        // whether the template is active at all).
        //
        // ── Rating-gate intercept (Pro upsell) ──────────────────────────────
        // Paid orgs (trial/starter/pro/enterprise — anything not free/expired)
        // get the intercept: mint a review_requests row and link the customer to
        // /r/{token}. There they pick a rating — happy (4-5★) → Google Business
        // Profile, unhappy (1-3★) → internal feedback the office sees. A bad
        // experience never becomes a public 1★. Free / expired orgs keep the
        // legacy direct-to-GBP link (the un-gated upsell pressure) by leaving
        // reviewLink undefined, which falls back to buildReviewLink inside the
        // helper. A mint failure also degrades to the legacy GBP link.
        const billing: OrgBilling = {
          plan: orgRow?.plan ?? "trial",
          planStatus: orgRow?.plan_status ?? "trial",
          trialEndsAt: orgRow?.trial_ends_at ?? null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          subscriptionAmountCents: 0,
        };
        const eff = effectiveStatus(billing);
        const gated = eff.plan !== "free" && eff.plan !== "expired";
        let reviewLink: string | undefined;
        if (gated) {
          const { data: rr } = await admin
            .from("review_requests")
            .insert({
              organization_id: organizationId,
              customer_id: customerId,
              visit_id: id,
              channel: "email",
            })
            .select("token")
            .single();
          const rrToken = (rr as unknown as { token: string } | null)?.token;
          if (rrToken) reviewLink = `${publicBaseUrl()}/r/${rrToken}`;
        }

        const reviewResults = await sendCustomerNotification({
          supabase: admin,
          event: "review_request",
          organizationId,
          visitId: id,
          customerId,
          jobName: jobRow?.name ?? null,
          address: jobRow?.address ?? null,
          serviceDate: cur.due_date,
          orgName,
          mapImageUrl,
          reviewLink,
        });

        notified = anySent(completeResults) || anySent(reviewResults);
      } else {
        // shouldNotifySkipped — a skip notice. No before/after photos or
        // property map on a skip; the service_skipped template uses
        // {{customer_name}} {{job_name}} {{address}} {{service_date}} {{org_name}}.
        const skippedResults = await sendCustomerNotification({
          supabase: admin,
          event: "service_skipped",
          organizationId,
          visitId: id,
          customerId,
          jobName: jobRow?.name ?? null,
          address: jobRow?.address ?? null,
          serviceDate: cur.due_date,
          orgName,
          reason: skipReason,
        });
        notified = anySent(skippedResults);
      }
    }

    // Stamp the one-shot flag regardless of send success / customer presence so
    // a transient failure or a no-customer visit doesn't re-fire next time.
    // done and skipped are mutually exclusive transitions (one status per
    // request), so exactly one flag is stamped here.
    const stampedAt = new Date().toISOString();
    await admin
      .from("lawn_visits")
      .update(shouldNotifyDone ? { notified_at: stampedAt } : { notified_skipped_at: stampedAt })
      .eq("id", id);
  }

  return NextResponse.json({ ok: true, notified });
}