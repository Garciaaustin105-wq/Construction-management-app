import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { OFFICE_LIKE } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import SignOutButton from "@/components/SignOutButton";
import Link from "next/link";
import { Users, Contact, Briefcase, Tag, CreditCard, Building } from "lucide-react";

export default async function ManagePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser(); if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const role = (profile?.role as string) ?? "crew";
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const isOfficeOrAdmin = role === "office" || role === "admin";
  const showBilling = role === "admin";
  const showPlatform = role === "super_admin";

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Manage" subtitle="People, billing & platform" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Link href="/admin/users" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <Users className="w-5 h-5" />
            <span>Users</span>
          </Link>
          {isOfficeOrAdmin && (
            <Link href="/admin/customers" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Contact className="w-5 h-5" />
              <span>Customers</span>
            </Link>
          )}
          {isOfficeOrAdmin && (
            <Link href="/admin/subcontractors" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Briefcase className="w-5 h-5" />
              <span>Subcontractors</span>
            </Link>
          )}
          {isOfficeOrAdmin && (
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
        </div>
        <SignOutButton />
      </main>
    </div>
  );
}