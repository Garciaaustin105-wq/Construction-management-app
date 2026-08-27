import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { sendLeadWelcomeEmail } from "@/lib/email";
import { effectiveStatus, type OrgBilling } from "@/lib/billing";
import { LEAD_SOURCE_VALUES, type LeadSource } from "@/lib/leads";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Public lead capture. A logged-out prospect submits the form at
// /lead/{lead_form_token} → this route inserts the lead, sends an auto-reply
// email to the prospect (bounded for free orgs), and drops a `new_lead`
// notification into the office feed. No auth — the lead_form_token in the body
// is the sole credential (mirrors lawn_visits.share_token / the /v portal).
//
// Service-role (bypasses RLS): this is the ONE trusted write boundary for
// public leads. Office CRUD happens client-side through RLS (tier_office_or_pm);
// there is no /api/leads/[id]. Validate token + fields strictly here.
//
// Variant-neutral: resolves the org by token, not by build variant. Lawn orgs
// get a token generated (leads.sql backfill + /api/signup); construction orgs
// have none → 404. The route must build clean on both deploys.

// Per-IP rate limit (mirrors /api/signup). Cheap spam defense for a public
// unauthenticated endpoint. SHARED across serverless instances via the
// Postgres-backed limiter in src/lib/rateLimit.ts — this was previously an
// in-memory Map, which on Vercel is per-instance and ephemeral and therefore
// barely limited anything.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

// Free orgs get at most this many auto-reply emails per calendar month (bounds
// Resend cost on the free tier). Paid orgs auto-reply to every lead. Hardcoded
// for launch — move to a PlanConfig field if more lead quotas appear.
const FREE_LEAD_AUTOREPLY_CAP = 50;

function monthStartISO(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function isLeadSource(v: unknown): v is LeadSource {
  return typeof v === "string" && (LEAD_SOURCE_VALUES as string[]).includes(v);
}

export async function POST(request: Request) {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return NextResponse.json(
      { error: "Server not configured" },
      { status: 500 }
    );
  }

  const limited = await checkRateLimit(
    `leads:ip:${clientIp(request)}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Honeypot: a real user never fills the hidden "company_website" field. Bots
  // do. Pretend success so the trap isn't revealed, but do nothing.
  const honeypot = body.company_website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    return NextResponse.json({ ok: true }, { status: 201 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const contactName =
    typeof body.contact_name === "string" ? body.contact_name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const serviceInterest =
    typeof body.service_interest === "string"
      ? body.service_interest.trim()
      : "";
  const source = isLeadSource(body.source) ? body.source : "website";
  const referralDetail =
    typeof body.referral_detail === "string"
      ? body.referral_detail.trim()
      : "";

  if (!token) {
    return NextResponse.json({ error: "Invalid form link" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!email && !phone) {
    return NextResponse.json(
      { error: "Email or phone is required" },
      { status: 400 }
    );
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false }
    }
  );

  // 1) Resolve the org by the public lead-form token. Only lawn-enabled orgs
  //    have a token, so a construction org (or a bogus token) 404s here. Read
  //    the billing columns too so we can compute the effective plan for the
  //    auto-reply cap in the same round-trip.
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id, name, app_variant, plan, plan_status, trial_ends_at")
    .eq("lead_form_token", token)
    .maybeSingle();
  const org = orgRow as unknown as {
    id: string;
    name: string | null;
    app_variant: string | null;
    plan: string | null;
    plan_status: string | null;
    trial_ends_at: string | null;
  } | null;
  if (!org || org.app_variant !== "lawn") {
    return NextResponse.json({ error: "Invalid form link" }, { status: 404 });
  }

  // 2) Insert the lead. status='new', source validated above.
  const { data: inserted, error: insertError } = await admin
    .from("leads")
    .insert({
      organization_id: org.id,
      name,
      contact_name: contactName || null,
      email: email || null,
      phone: phone || null,
      address: address || null,
      service_interest: serviceInterest || null,
      source,
      referral_detail: referralDetail || null,
      status: "new",
    })
    .select("id, email, contact_name, name")
    .single();
  if (insertError || !inserted) {
    return NextResponse.json(
      { error: `Could not submit: ${insertError?.message ?? "error"}` },
      { status: 500 }
    );
  }
  const lead = inserted as unknown as {
    id: string;
    email: string | null;
    contact_name: string | null;
    name: string;
  };

  // 3) Office feed: a `new_lead` notification so the office dashboard badge +
  //    Home feed pick it up (reuses notifications.sql). unique (type,
  //    entity_id) → onConflict ignore is harmless (new lead id = no conflict).
  await admin
    .from("notifications")
    .upsert(
      {
        organization_id: org.id,
        type: "new_lead",
        title: "New lead",
        body: name,
        entity_id: lead.id,
        href: "/admin/leads",
      },
      { onConflict: "type,entity_id", ignoreDuplicates: true }
    );

  // 4) Auto-reply to the prospect. Free orgs are capped at
  //    FREE_LEAD_AUTOREPLY_CAP/month (bounds Resend cost); paid orgs always
  //    send. Non-fatal: a failed send is logged, never blocks the capture.
  let autoReply: "sent" | "skipped_cap" | "skipped_no_email" | "failed" =
    "skipped_no_email";
  const billing: OrgBilling = {
    plan: org.plan ?? "trial",
    planStatus: org.plan_status ?? "trial",
    trialEndsAt: org.trial_ends_at,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionAmountCents: 0,
  };
  const eff = effectiveStatus(billing);
  const isFree = eff.plan === "free";

  if (lead.email) {
    let withinCap = true;
    if (isFree) {
      const { count } = await admin
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .gte("created_at", monthStartISO());
      withinCap = (count ?? 0) < FREE_LEAD_AUTOREPLY_CAP;
    }
    if (withinCap) {
      const result = await sendLeadWelcomeEmail({
        to: lead.email,
        name: lead.contact_name || lead.name,
        orgName: org.name ?? "Our team",
      });
      autoReply = result.error ? "failed" : "sent";
    } else {
      autoReply = "skipped_cap";
    }
  }

  // Log the auto-reply attempt to notification_log (mirrors the customer
  // notification log). Service-role insert bypasses RLS.
  await admin.from("notification_log").insert({
    organization_id: org.id,
    event: "lead_welcome",
    channel: "email",
    to_contact: lead.email,
    entity_type: "lead",
    entity_id: lead.id,
    status:
      autoReply === "sent"
        ? "sent"
        : autoReply === "failed"
        ? "failed"
        : "skipped",
  });

  return NextResponse.json({ ok: true, leadId: lead.id, autoReply }, { status: 201 });
}

export function GET() {
  // Public endpoint exists for POST only; a GET is a probe. Respond plainly.
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}