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
// Abuse surface (deferred, per plan): no captcha / no rate limiting / no email
// verification beyond Supabase Auth's built-in email limits. We do enforce
// one-org-per-email and a minimum password length.

export async function POST(request: Request) {
  if (process.env.SAAS_OPEN !== "true") {
    return NextResponse.json(
      { error: "Signups are not open yet." },
      { status: 503 }
    );
  }

  const body = await request.json();
  const { business_name, full_name, email, password } = body as {
    business_name?: string;
    full_name?: string;
    email?: string;
    password?: string;
  };

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