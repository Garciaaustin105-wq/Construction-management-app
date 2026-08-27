import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { applyApprovedChangeOrderToInvoice } from "@/lib/changeOrderInvoice";
import { checkRateLimits, clientIp, rateLimitResponse } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Frictionless customer change-order decision — public (no auth); the
// share_token in the URL is the only credential. Mirrors the estimate decide
// route but for change orders. Service role because there is no user session.
// Guards: token must resolve + status must be 'sent'. On approve/reject the CO
// is flipped to approved/rejected with the matching <event>_at and the office
// is notified via the in-app feed (NON-FATAL). No invoice is created in v1 —
// the office adds an approved CO to an invoice manually (follow-up).
//
// NOTE: unlike the estimate flow there is no double-click invoice guard needed
// here (no side-effect rows are created); the unique (type, entity_id)
// notification index still dedups a repeated decision.

function requestOrigin(request: Request): string {
  const xfhost = request.headers.get("x-forwarded-host");
  const host =
    xfhost ||
    request.headers.get("host") ||
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return "localhost";
      }
    })();
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Public token endpoint — throttle so a leaked link can't be used to spam
  // decisions. Keyed on token AND IP. Generous: a customer decides once.
  const limited = await checkRateLimits([
    { key: `co-decide:token:${token}`, max: 10, windowSeconds: 3600 },
    { key: `co-decide:ip:${clientIp(request)}`, max: 40, windowSeconds: 3600 },
  ]);
  if (!limited.allowed) return rateLimitResponse(limited);

  let body: { decision?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: "decision must be 'approve' or 'reject'" },
      { status: 400 }
    );
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: co } = await admin
    .from("change_orders")
    .select(
      "id, status, organization_id, job_id, co_number, title, amount, is_credit, jobs(name), customers(name)"
    )
    .eq("share_token", token)
    .maybeSingle();

  if (!co) {
    return NextResponse.json({ error: "Change order not found" }, { status: 404 });
  }
  if (co.status !== "sent") {
    return NextResponse.json(
      { error: "This change order is not awaiting action." },
      { status: 400 }
    );
  }

  const jobName =
    (co.jobs as unknown as { name: string } | null)?.name ??
    (co.title as string | null) ??
    "your project";
  const customerName =
    (co.customers as unknown as { name: string | null } | null)?.name ?? "";
  const coNumber = (co.co_number as string | null) ?? null;

  // Record an in-app notification for the office feed on the dashboard. Service
  // role (bypasses RLS). NON-FATAL — the CO state change already succeeded by
  // the time this runs; a DB hiccup must never fail the decision. The unique
  // (type, entity_id) index makes a double-click a no-op.
  const recordNotification = async (
    type: "change_order_approved" | "change_order_rejected",
    title: string
  ) => {
    try {
      await admin.from("notifications").insert({
        organization_id: co.organization_id,
        type,
        title,
        body: [customerName, jobName].filter(Boolean).join(" · "),
        href: `/change-orders/${co.id}`,
        entity_id: co.id,
      });
    } catch {
      // Swallow — feed is best-effort.
    }
  };

  const now = new Date().toISOString();
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const stamp = decision === "approve" ? { approved_at: now } : { rejected_at: now };

  const { error } = await admin
    .from("change_orders")
    .update({ status: nextStatus, ...stamp, updated_at: now })
    .eq("id", co.id);
  if (error) {
    return NextResponse.json(
      { error: `Failed: ${error.message}` },
      { status: 500 }
    );
  }

  await recordNotification(
    decision === "approve" ? "change_order_approved" : "change_order_rejected",
    decision === "approve" ? "Change order approved" : "Change order rejected"
  );

  // Issue 4: pull the approved CO onto the original estimate's invoice as a line
  // item (non-fatal — the approval already succeeded). No-op for rejects,
  // deposit-only jobs, paid invoices, or COs already added.
  if (decision === "approve") {
    try {
      await applyApprovedChangeOrderToInvoice(admin, co.id);
    } catch {
      // best-effort; never fail the decision over the invoice line
    }
  }

  return NextResponse.json({ ok: true, status: nextStatus });
}