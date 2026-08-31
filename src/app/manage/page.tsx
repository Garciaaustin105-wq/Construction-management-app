import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { OFFICE_LIKE } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { SUPPORT_EMAIL } from "@/lib/legal";
import TopBar from "@/components/TopBar";
import SignOutButton from "@/components/SignOutButton";
import Link from "next/link";
import { Users, Briefcase, Tag, CreditCard, Building, Building2, LifeBuoy, UserCog } from "lucide-react";

export default async function ManagePage() {
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const isOfficeOrAdmin = role === "office" || role === "admin";
  const showBilling = role === "office" || role === "admin";
  const showPlatform = role === "super_admin";
  // Org admin only, not office/super_admin -- the one in-app support contact
  // surface, scoped narrowly per the user's own call rather than opened to
  // every office-like role.
  const showSupport = role === "admin";
  // /admin/org gates on `role === "admin" || isSuperAdmin`, so match it exactly
  // rather than approximating — a card that leads to a redirect is worse than
  // no card. It is surfaced here because its ONLY other link is a button on
  // /dashboard, and the lawn variant redirects /dashboard away to /lawn — so on
  // lawn, org settings was unreachable.
  const showOrgSettings = role === "admin" || me.isSuperAdmin;

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Account" subtitle="Your login, people & billing" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Link href="/account" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <UserCog className="w-5 h-5" />
            <span>Account</span>
          </Link>
          <Link href="/admin/users" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <Users className="w-5 h-5" />
            <span>Users</span>
          </Link>
          {showOrgSettings && (
            <Link href="/admin/org" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Building2 className="w-5 h-5" />
              <span>Org settings</span>
            </Link>
          )}
          {isOfficeOrAdmin && !isLawn() && (
            <Link href="/admin/subcontractors" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Briefcase className="w-5 h-5" />
              <span>Subcontractors</span>
            </Link>
          )}
          {isOfficeOrAdmin && !isLawn() && (
            <Link href="/admin/cost-codes" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Tag className="w-5 h-5" />
              <span>Cost Codes</span>
            </Link>
          )}
          {showBilling && (
            <Link href="/admin/billing" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <CreditCard className="w-5 h-5" />
              <span>Billing</span>
            </Link>
          )}
          {showPlatform && (
            <Link href="/admin/orgs" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Building className="w-5 h-5" />
              <span>Platform</span>
            </Link>
          )}
          {showSupport && (
            <a href={`mailto:${SUPPORT_EMAIL}`} className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <LifeBuoy className="w-5 h-5" />
              <span>Contact support</span>
            </a>
          )}
        </div>
        <SignOutButton />
      </main>
    </div>
  );
}