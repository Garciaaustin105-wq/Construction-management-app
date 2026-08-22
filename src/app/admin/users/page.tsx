import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import NewUserForm from "./NewUserForm";
import { isOfficeLike } from "@/lib/roles";

// SERVER GUARD. The old page was "use client" with no role check — a logged-in
// crew member who typed /admin/users saw the full form (only the API 403
// stopped the actual create). This wrapper admits office / admin / super_admin
// only; everyone else is redirected before the form ever loads.
export default async function NewUserPage() {
  const supabase = await createClient();
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role;
  if (!isOfficeLike(role)) redirect("/dashboard");

  const orgId = me.orgId;

  // super_admin provisions users into ANY org → load the org list for the picker.
  let orgs: { id: string; name: string }[] = [];
  if (role === "super_admin") {
    const { data: orgRows } = await supabase
      .from("organizations")
      .select("id, name")
      .order("name");
    orgs = (orgRows as { id: string; name: string }[]) ?? [];
  }

  return <NewUserForm callerRole={role} orgId={orgId} orgs={orgs} />;
}