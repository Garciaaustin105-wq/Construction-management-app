import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMe } from "@/lib/tenant";

// Update the caller's organization business info (name/address/phone/email/logo).
//   admin → may edit only their OWN org.
//   super_admin / office / PM / crew / customer → 403 (org identity is
//   admin-only; super_admin is a read-only platform-overview role — see
//   super_admin_readonly_orgs.sql for the matching RLS gate).
export async function PATCH(request: Request) {
  const supabase = await createClient();
  // One cached identity read (shared with the root layout) instead of
  // getUser() + getMyOrg()'s own getUser() + profiles + organizations.
  const tenant = await getMe();
  if (!tenant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  // Org business-info is editable by the org's own admin ONLY. super_admin is a
  // platform-overview role and must NOT mutate tenant identity.
  if (tenant.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();
  const {
    name,
    address,
    phone,
    email,
    logo_path,
    default_labor_rate,
    default_labor_cost_rate,
    default_mobilization_hours,
  } = body as {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    logo_path?: string;
    default_labor_rate?: number | string | null;
    default_labor_cost_rate?: number | string | null;
    default_mobilization_hours?: number | string | null;
  };

  // Admin edits only their own org. (body.organization_id, if sent by an old
  // client, is ignored — an admin cannot target another org.)
  if (!tenant.orgId) {
    return NextResponse.json(
      { error: "Your account has no organization" },
      { status: 403 }
    );
  }
  const targetOrgId = tenant.orgId;

  // Numeric validation: 0 is a valid value and must be written as 0; null
  // indicates "not set" and is distinct from 0. Empty strings are treated as
  // null. Any other value (negative, NaN, Infinity, non-numeric strings)
  // results in a 400 error.
  const update: Record<string, string | number | null> = {};

  if (typeof name === "string") update.name = name.trim() || null;
  if (typeof address === "string") update.address = address.trim() || null;
  if (typeof phone === "string") update.phone = phone.trim() || null;
  if (typeof email === "string") update.email = email.trim() || null;
  if (typeof logo_path === "string") update.logo_path = logo_path || null;

  // Validate default_labor_rate
  if (default_labor_rate !== undefined) {
    if (default_labor_rate === null) {
      update.default_labor_rate = null;
    } else if (typeof default_labor_rate === "string" && default_labor_rate.trim() === "") {
      update.default_labor_rate = null;
    } else if (typeof default_labor_rate === "number" && isFinite(default_labor_rate) && default_labor_rate >= 0) {
      update.default_labor_rate = default_labor_rate;
    } else {
      return NextResponse.json(
        { error: "default_labor_rate must be a number of 0 or more" },
        { status: 400 }
      );
    }
  }

  // Validate default_labor_cost_rate
  if (default_labor_cost_rate !== undefined) {
    if (default_labor_cost_rate === null) {
      update.default_labor_cost_rate = null;
    } else if (typeof default_labor_cost_rate === "string" && default_labor_cost_rate.trim() === "") {
      update.default_labor_cost_rate = null;
    } else if (typeof default_labor_cost_rate === "number" && isFinite(default_labor_cost_rate) && default_labor_cost_rate >= 0) {
      update.default_labor_cost_rate = default_labor_cost_rate;
    } else {
      return NextResponse.json(
        { error: "default_labor_cost_rate must be a number of 0 or more" },
        { status: 400 }
      );
    }
  }

  // Validate default_mobilization_hours
  if (default_mobilization_hours !== undefined) {
    if (default_mobilization_hours === null) {
      update.default_mobilization_hours = null;
    } else if (typeof default_mobilization_hours === "string" && default_mobilization_hours.trim() === "") {
      update.default_mobilization_hours = null;
    } else if (typeof default_mobilization_hours === "number" && isFinite(default_mobilization_hours) && default_mobilization_hours >= 0) {
      update.default_mobilization_hours = default_mobilization_hours;
    } else {
      return NextResponse.json(
        { error: "default_mobilization_hours must be a number of 0 or more" },
        { status: 400 }
      );
    }
  }

  // name is NOT NULL on organizations — don't blank it.
  if (update.name === null) delete update.name;

  const { error } = await supabase
    .from("organizations")
    .update(update)
    .eq("id", targetOrgId);

  if (error) {
    return NextResponse.json(
      { error: `Update failed: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}