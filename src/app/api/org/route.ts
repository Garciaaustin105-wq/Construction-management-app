import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getMyOrg } from "@/lib/tenant";

// Update the caller's organization business info (name/address/phone/email/logo).
//   admin → may edit only their OWN org.
//   super_admin / office / PM / crew / customer → 403 (org identity is
//   admin-only; super_admin is a read-only platform-overview role — see
//   super_admin_readonly_orgs.sql for the matching RLS gate).
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
  // Org business-info is editable by the org's own admin ONLY. super_admin is a
  // platform-overview role and must NOT mutate tenant identity.
  if (tenant.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();
  const { name, address, phone, email, logo_path } = body as {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    logo_path?: string;
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