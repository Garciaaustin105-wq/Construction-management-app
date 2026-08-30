import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { sendVerificationEmail } from "@/lib/email";
import { ensureStripeCustomer, TRIAL_DAYS } from "@/lib/billing";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";
import { verifyTurnstile } from "@/lib/turnstile";
import { captureException } from "@/lib/sentry";

export const dynamic = "force-dynamic";

// Public self-serve signup: a new business owner creates their organization
// and becomes its admin. No auth required — this is the front door for new
// tenants.
//
// Env-gated by SAAS_OPEN: keep it "false" (unset) until multi_tenancy_b.sql
// is live, so no second org can sign up during the policy-rewrite window.
//
// Abuse protection: a hidden honeypot field ("company_website"), a per-IP
// rate limit (max 5 signups/hour), and Cloudflare Turnstile CAPTCHA
// (src/lib/turnstile.ts — verifyTurnstile fails OPEN with a distinguishable
// "not_configured" signal until TURNSTILE_SECRET_KEY is set, so this route
// isn't hard-broken before that env var exists). There is no email
// verification beyond Supabase Auth's built-in limits. The rate limit is
// SHARED across serverless instances (Postgres-backed — see
// src/lib/rateLimit.ts); it was previously an in-memory Map, which on Vercel
// is per-instance and ephemeral and so barely limited anything.

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour

export async function POST(request: Request) {
  if (process.env.SAAS_OPEN !== "true") {
    return NextResponse.json(
      { error: "Signups are not open yet." },
      { status: 503 }
    );
  }

  const limited = await checkRateLimit(
    `signup:ip:${clientIp(request)}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Too many signups from this network. Try again later." },
      { status: 429 }
    );
  }

  const body = await request.json();
  const {
    business_name,
    full_name,
    email,
    password,
    company_website,
    variant,
    attribution,
    captcha_token,
  } = body as {
    business_name?: string;
    full_name?: string;
    email?: string;
    password?: string;
    company_website?: string;
    variant?: string;
    attribution?: Record<string, unknown>;
    captcha_token?: string;
  };

  const captcha = await verifyTurnstile(captcha_token, clientIp(request));
  if (!captcha.success) {
    if (captcha.error !== "not_configured") {
      captureException(new Error(`signup captcha failed: ${captcha.error}`), {
        extra: { ip: clientIp(request) },
      });
    }
    return NextResponse.json(
      { error: "Captcha verification failed. Please try again." },
      { status: 400 }
    );
  }

  // Signup-source attribution (utm_* + referrer) from src/lib/attribution.ts.
  // Untrusted client input — allowlist the known keys and cap length so a
  // malformed/hostile payload can't write arbitrary columns or oversized
  // strings. Absent/malformed attribution is not an error; it just means no
  // channel data (a direct visit, or storage blocked).
  const ATTRIBUTION_KEYS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "referrer",
  ] as const;
  const attributionColumns: Record<string, string> = {};
  if (attribution && typeof attribution === "object") {
    for (const key of ATTRIBUTION_KEYS) {
      const v = attribution[key];
      if (typeof v === "string" && v.trim()) {
        const column = key === "referrer" ? "signup_referrer" : key;
        attributionColumns[column] = v.trim().slice(0, 255);
      }
    }
  }

  // Honeypot: a real user never fills the hidden "company_website" field. Bots
  // do. Pretend success so the trap isn't revealed, but do nothing.
  if (company_website && company_website.trim().length > 0) {
    return NextResponse.json(
      { ok: true, userId: "00000000-0000-0000-0000-000000000000" },
      { status: 201 }
    );
  }

  const bizName = (business_name ?? "").trim();
  const name = (full_name ?? "").trim();
  const mail = (email ?? "").trim().toLowerCase();

  if (!bizName || !name || !mail || !password) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // One org per email: reject if a profile already uses this email.
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("email", mail)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 }
    );
  }

  // 1. Create the organization.
  // Lawn signups land on the capped FREE tier (no card, never expires, walled
  // at 25 customers/1 seat/1GB by the DB triggers); construction keeps the
  // 30-day trial. See src/lib/plans.ts (free entry) + plan_limits_v2.sql.
  const isLawnSignup = variant === "lawn";
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({
      name: bizName,
      email: mail,
      plan: isLawnSignup ? "free" : "trial",
      // free is a persistent active plan (the column default 'trial' would be
      // misleading for a free org); construction trial leaves plan_status to the
      // column default.
      ...(isLawnSignup ? { plan_status: "active" } : {}),
      // Lawn orgs get a public lead-form token immediately so the office can
      // share /lead/{token} the moment they land (the CRM lead pipeline).
      // Construction orgs get none for launch (no lead form) — left null.
      ...(isLawnSignup ? { lead_form_token: crypto.randomUUID() } : {}),
      // Stamp the platform variant sent by the signup form (construction app
      // sends "construction", lawn app sends "lawn"). Drives the DB trigger
      // guard + tenant.ts appVariant. Defaults to construction if absent.
      app_variant: isLawnSignup ? "lawn" : "construction",
      // Which channel this signup came from (Google Ads, organic blog link,
      // etc.) — see attribution_and_signup_source.sql + src/lib/attribution.ts.
      ...attributionColumns,
    })
    .select("id")
    .single();
  if (orgErr || !org) {
    return NextResponse.json(
      { error: `Organization creation failed: ${orgErr?.message ?? "error"}` },
      { status: 500 }
    );
  }

  // 2. Create the auth user (admin role) AND generate the email-verification
  //    link in one call. admin.generateLink({type:'signup'}) creates the user
  //    UNCONFIRMED (email_confirmed_at stays null) and returns the verify link
  //    (properties.action_link) for us to deliver via Resend — it does not send
  //    the email itself. The user cannot sign in until they click the link:
  //    once "Confirm email" is enabled in Supabase Auth, signInWithPassword
  //    rejects unconfirmed users with error 'email_not_confirmed'.
  const origin = new URL(request.url).origin;
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "signup",
      email: mail,
      password,
      options: {
        redirectTo: `${origin}/auth/callback?flow=signup`,
        data: { role: "admin", full_name: name },
      },
    });
  if (linkError || !linkData.user || !linkData.properties?.action_link) {
    // Roll back the org.
    await admin.from("organizations").delete().eq("id", org.id);
    return NextResponse.json(
      { error: linkError?.message ?? "Failed to create user" },
      { status: 500 }
    );
  }

  const newUserId = linkData.user.id;
  const verifyLink = linkData.properties.action_link;

  // 3. Create the admin profile, stamped with the new org.
  const { error: profileError } = await admin.from("profiles").insert({
    id: newUserId,
    email: mail,
    full_name: name,
    role: "admin",
    organization_id: org.id,
  });
  if (profileError) {
    // Roll back auth user + org.
    await admin.auth.admin.deleteUser(newUserId);
    await admin.from("organizations").delete().eq("id", org.id);
    return NextResponse.json(
      { error: `Profile creation failed: ${profileError.message}` },
      { status: 500 }
    );
  }

  // 4. Link the org's owner_id back to the new admin profile.
  await admin.from("organizations").update({ owner_id: newUserId }).eq("id", org.id);

  // 4b. CONSTRUCTION ONLY: create the Stripe customer + start the 30-day trial.
  //     Lawn signups land on the free tier — no Stripe customer is created (no
  //     card required; free never expires) and no trial_ends_at is set. The
  //     Stripe customer is backfilled on the first billing interaction via
  //     ensureStripeCustomer if the free org ever upgrades. NON-FATAL: if Stripe
  //     isn't configured (e.g. local dev) or errors, the construction workspace
  //     still works — plan stays 'trial' with trial_ends_at null, which
  //     effectiveStatus treats as an open (non-expiring) trial.
  if (!isLawnSignup && process.env.STRIPE_SECRET_KEY) {
    try {
      await ensureStripeCustomer({
        id: org.id,
        name: bizName,
        email: mail,
        stripeCustomerId: null,
      });
      const trialEndsAt = new Date(
        Date.now() + TRIAL_DAYS * 86_400_000
      ).toISOString();
      await admin
        .from("organizations")
        .update({ trial_ends_at: trialEndsAt })
        .eq("id", org.id);
    } catch {
      // Stripe error — workspace is still usable; billing can be set up later.
    }
  }

  // 5. Send the verification email. NON-FATAL: by this point the workspace is
  //    fully created (unconfirmed). If the email send fails we do NOT roll back —
  //    that would destroy the user's org over a transient provider issue.
  //
  //    Delivery strategy: prefer the branded Resend email (needs RESEND_API_KEY
  //    AND a verified RESEND_FROM sending domain). If Resend is NOT configured,
  //    or the send fails, fall back to Supabase's built-in verification email
  //    (supabase.auth.resend). This is critical: Resend's onboarding address
  //    (onboarding@resend.com, the default when RESEND_FROM is unset) ONLY
  //    delivers to the Resend account owner — so without a verified sending
  //    domain a new business owner would NEVER receive their verification
  //    link, be left unconfirmed, and locked out of sign-in. Supabase's sender
  //    is rate-limited but delivers to any inbox with zero config, so signup
  //    verification can never silently fail again.
  let emailSent = true;
  const resendReady = !!(
    process.env.RESEND_API_KEY && process.env.RESEND_FROM
  );
  let useSupabaseFallback = !resendReady;
  if (resendReady) {
    try {
      const result = await sendVerificationEmail({ to: mail, name, verifyLink });
      if (result.error) {
        // Resend rejected (e.g. unverified domain) — fall back.
        useSupabaseFallback = true;
      }
    } catch {
      // Resend threw (key issue, network) — fall back.
      useSupabaseFallback = true;
    }
  }
  if (useSupabaseFallback) {
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const anon = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      const { error: rErr } = await anon.auth.resend({
        type: "signup",
        email: mail,
        options: { emailRedirectTo: `${origin}/auth/callback?flow=signup` },
      });
      if (rErr) emailSent = false;
    } catch {
      emailSent = false;
    }
  }

  return NextResponse.json(
    { ok: true, userId: newUserId, organizationId: org.id, emailSent },
    { status: 201 }
  );
}