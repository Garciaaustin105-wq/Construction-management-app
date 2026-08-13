import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";

// Update the caller's organization business info (name/address/phone/email/logo).
//   admin       → may edit only their OWN org.
//   super_admin → may edit any org (body.organization_id required).
// office/PM/crew/customer → 403 (org info is admin-only, per the admin>office
// decision).
export async function PATCH(request: Request) {
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
  if (tenant.role !== "admin" && tenant.role !== "super_admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();
  const { name, address, phone, email, logo_path, organization_id } = body as {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    logo_path?: string;
    organization_id?: string;
  };

  // Determine target org.
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

  const update: Record<string, string | null> = {};
  if (typeof name === "string") update.name = name.trim() || null;
  if (typeof address === "string") update.address = address.trim() || null;
  if (typeof phone === "string") update.phone = phone.trim() || null;
  if (typeof email === "string") update.email = email.trim() || null;
  if (typeof logo_path === "string") update.logo_path = logo_path || null;

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