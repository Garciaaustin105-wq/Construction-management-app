import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { getMyOrg } from "@/lib/tenant";
import { ASSIGNABLE_ROLES, isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { getOrgBilling, createGate, effectiveStatus } from "@/lib/billing";
import { getLimits } from "@/lib/plans";

// Create a new user (auth + profile, + customer row when role=customer).
//
// Multi-tenancy: every new profile is stamped with an organization_id.
//   - office / admin → forced to the CALLER's org (the body's organization_id
//     is ignored). office may create crew/super/PM/customer only; admin may
//     create any assignable role (incl. office + admin).
//   - super_admin    → may target ANY org via body.organization_id (validated
//     to exist); can create any assignable role. Used for provisioning.
//
// Service role is used to create the auth user + profile + customer, which
// bypasses RLS — so the org scoping here is the enforcement (there is no
// `with check` for service-role writes; see the multi-tenancy plan).

// Roles an office user (non-admin) may create: field + sales + client roles.
// Accountant is NOT here — it's a sensitive financial role, admin/super_admin only.
const OFFICE_CREATABLE = new Set([
  "crew",
  "superintendent",
  "project_manager",
  "sales",
  "customer",
]);

function canCreate(callerRole: string, targetRole: string): boolean {
  if (isSuperAdmin(callerRole)) return ASSIGNABLE_ROLES.includes(targetRole as never);
  if (callerRole === "admin") return ASSIGNABLE_ROLES.includes(targetRole as never);
  if (callerRole === "office") return OFFICE_CREATABLE.has(targetRole as never);
  return false;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const tenant = await getMyOrg(supabase);
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!isOfficeLike(tenant.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const body = await request.json();
  const { email, password, full_name, role, customer_name, organization_id } =
    body;

  if (!email || !password || !role) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (!ASSIGNABLE_ROLES.includes(role as never)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (!canCreate(tenant.role, role)) {
    return NextResponse.json(
      { error: `Your role (${tenant.role}) cannot create a ${role} user` },
      { status: 403 }
    );
  }

  // Determine the target org for the new user.
  //   super_admin → must supply a valid organization_id (provisioning).
  //   office / admin → forced to the caller's own org.
  let targetOrgId: string;
  if (tenant.isSuperAdmin) {
    if (!organization_id) {
      return NextResponse.json(
        { error: "organization_id is required for super admin" },
        { status: 400 }
      );
    }
    targetOrgId = String(organization_id);
  } else {
    if (!tenant.orgId) {
      return NextResponse.json(
        { error: "Your account has no organization" },
        { status: 403 }
      );
    }
    targetOrgId = tenant.orgId;
  }

  // Service role client - has admin privileges, bypasses RLS
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // For super_admin, verify the target org actually exists.
  if (tenant.isSuperAdmin) {
    const { data: org } = await admin
      .from("organizations")
      .select("id")
      .eq("id", targetOrgId)
      .single();
    if (!org) {
      return NextResponse.json(
        { error: "Target organization not found" },
        { status: 400 }
      );
    }
  }

  // ── Billing gate: block user creation when the org's plan is expired/canceled
  //    or at its seat cap. Customers (portal users) are excluded from the count.
  //    Uses the service-role admin client so super_admin targeting another org
  //    still reads that org's billing row (RLS would scope the user client).
  const billing = await getOrgBilling(admin, targetOrgId);
  if (billing) {
    const gate = createGate(billing);
    if (gate) {
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }
    const eff = effectiveStatus(billing);
    const { maxUsers } = getLimits(eff.plan);
    if (maxUsers !== null) {
      const { count } = await admin
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", targetOrgId)
        .neq("role", "customer");
      if ((count ?? 0) >= maxUsers) {
        return NextResponse.json(
          {
            error: `Seat limit reached (${maxUsers} users on the ${eff.plan} plan). Upgrade to add more users.`,
          },
          { status: 402 }
        );
      }
    }
  }

  // Create the auth user
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role, full_name },
      app_metadata: { role },
    });

  if (authError || !authData.user) {
    return NextResponse.json(
      { error: authError?.message ?? "Failed to create user" },
      { status: 500 }
    );
  }

  const newUserId = authData.user.id;

  // Create the profile, stamped with the target org.
  const { error: profileError } = await admin.from("profiles").insert({
    id: newUserId,
    email,
    full_name: full_name || null,
    role,
    organization_id: targetOrgId,
  });

  if (profileError) {
    // Roll back: delete the auth user
    await admin.auth.admin.deleteUser(newUserId);
    return NextResponse.json(
      { error: `Profile creation failed: ${profileError.message}` },
      { status: 500 }
    );
  }

  // If creating a customer, also create the customer record (in the same org)
  // and LINK the profile to it. Without profiles.customer_id the new customer
  // sees an empty portal — the customer RLS policies key off customer_id.
  if (role === "customer") {
    const customerName = customer_name || full_name || email;
    const { data: custData, error: custError } = await admin
      .from("customers")
      .insert({
        name: customerName,
        contact_email: email,
        contact_name: full_name || null,
        organization_id: targetOrgId,
      })
      .select()
      .single();
    if (custError) {
      // Don't roll back - customer record is optional metadata
    } else if (custData) {
      await admin
        .from("profiles")
        .update({ customer_id: custData.id })
        .eq("id", newUserId);
    }
  }

  return NextResponse.json({ ok: true, userId: newUserId });
}