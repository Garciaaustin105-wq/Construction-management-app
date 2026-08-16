import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { OFFICE_LIKE } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import { Receipt, FileText, Calendar, ClipboardList, CheckSquare, FileDiff } from "lucide-react";

export default async function OfficePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser(); if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const role = (profile?.role as string) ?? "crew";
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const showReports = role === "office" || role === "admin";  // /admin/reports excludes super_admin

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Office" subtitle="Records, reports & schedule" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <Link href="/receipts" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <Receipt className="w-5 h-5" />
            Receipts
          </Link>
          <Link href="/daily-logs" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <ClipboardList className="w-5 h-5" />
            Daily Logs
          </Link>
          <Link href="/punch" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <CheckSquare className="w-5 h-5" />
            Punch List
          </Link>
          <Link href="/change-orders" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <FileDiff className="w-5 h-5" />
            Change Orders
          </Link>
          <Link href="/submittals" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <FileText className="w-5 h-5" />
            Submittals
          </Link>
          {showReports && (
            <Link href="/admin/reports" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <FileText className="w-5 h-5" />
              Reports
            </Link>
          )}
          <Link href="/calendar" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <Calendar className="w-5 h-5" />
            Calendar
          </Link>
        </div>
      </main>
    </div>
  );
}