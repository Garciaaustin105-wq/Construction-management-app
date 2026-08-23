import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { OFFICE_LIKE } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import PageContainer from "@/components/PageContainer";
import Link from "next/link";
import { Receipt, FileText, Calendar, ClipboardList, CheckSquare, FileDiff, FileSpreadsheet, Clock, TrendingUp, Bell, Images, Camera } from "lucide-react";

export default async function OfficePage() {
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");

  const showReports = role === "office" || role === "admin";  // /admin/reports excludes super_admin

  return (
    <PageContainer title="Office" subtitle="Records, reports & schedule" maxWidth="list">
      <div className="grid grid-cols-2 gap-2">
        {isLawn() ? (
          <>
            <Link href="/estimates" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <FileText className="w-5 h-5" />
              Estimates
            </Link>
            <Link href="/invoices" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Receipt className="w-5 h-5" />
              Invoices
            </Link>
            {showReports && (
              <Link href="/admin/reports" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
                <FileSpreadsheet className="w-5 h-5" />
                Reports
              </Link>
            )}
            <Link href="/calendar" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Calendar className="w-5 h-5" />
              Calendar
            </Link>
            {/* Photos (/crew/photo) — lawn has no Field hub (construction
                reaches it from Field), so the photo capture page lives on
                the Office hub for mobile. Matches the desktop sidebar, which
                already gives office/admin a Photos tab. */}
            <Link href="/crew/photo" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Camera className="w-5 h-5" />
              Photos
            </Link>
            {/* Customers lives on the Manage tab only — it was duplicated
                here too (Office AND Manage both linking to /admin/customers),
                which read as "two customer tabs doing the same thing." */}
            <Link href="/crew/time" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Clock className="w-5 h-5" />
              Time Clock
            </Link>
            <Link href="/lawn/insights" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <TrendingUp className="w-5 h-5" />
              Insights
            </Link>
            <Link href="/lawn/notifications" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Bell className="w-5 h-5" />
              Notifications
            </Link>
          </>
        ) : (
          <>
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
            {/* Global photo browser (/photos) — collects every job's photos
                in one place. It already existed but had no nav entry point
                anywhere in the app, so it was effectively unreachable. */}
            <Link href="/photos" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
              <Images className="w-5 h-5" />
              Photos
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
          </>
        )}
      </div>
    </PageContainer>
  );
}