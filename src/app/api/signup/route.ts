import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// Public self-serve signup: a new business owner creates their organization
// and becomes its admin. No auth required — this is the front door for new
// tenants.
//
// Env-gated by SAAS_OPEN: keep it "false" (unset) until multi_tenancy_b.sql
// is live, so no second org can sign up during the policy-rewrite window.
//
// Abuse protection: a hidden honeypot field ("company_website") + a per-IP
// rate limit (max 5 signups/hour). There is no captcha and no email verification
// beyond Supabase Auth's built-in limits. The rate limit is in-memory, so it
// resets on cold start and is not shared across serverless instances — fine for
// a solo launch; swap in Upstash Ratelimit (@upstash/ratelimit + redis) when
// shared, persistent limits are needed.

// Per-IP signup timestamps (ms) within the rolling 1h window. Module-level so
// it survives across requests within a single instance lifetime.
const signupHits = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 5;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (signupHits.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (hits.length >= RATE_LIMIT_MAX) {
    signupHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  signupHits.set(ip, hits);
  return false;
}

function clientIp(request: Request): string {
  const xfwd = request.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0].trim();
  return "unknown";
}

export async function POST(request: Request) {
  if (process.env.SAAS_OPEN !== "true") {
    return NextResponse.json(
      { error: "Signups are not open yet." },
      { status: 503 }
    );
  }

  const ip = clientIp(request);
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many signups from this network. Try again later." },
      { status: 429 }
    );
  }

  const body = await request.json();
  const { business_name, full_name, email, password, company_website } =
    body as {
      business_name?: string;
      full_name?: string;
      email?: string;
      password?: string;
      company_website?: string;
    };

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
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .insert({ name: bizName, email: mail, plan: "trial" })
    .select("id")
    .single();
  if (orgErr || !org) {
    return NextResponse.json(
      { error: `Organization creation failed: ${orgErr?.message ?? "error"}` },
      { status: 500 }
    );
  }

  // 2. Create the auth user (admin role).
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email: mail,
      password,
      email_confirm: true,
      user_metadata: { role: "admin", full_name: name },
      app_metadata: { role: "admin" },
    });
  if (authError || !authData.user) {
    // Roll back the org.
    await admin.from("organizations").delete().eq("id", org.id);
    return NextResponse.json(
      { error: authError?.message ?? "Failed to create user" },
      { status: 500 }
    );
  }

  const newUserId = authData.user.id;

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

  return NextResponse.json(
    { ok: true, userId: newUserId, organizationId: org.id },
    { status: 201 }
  );
}