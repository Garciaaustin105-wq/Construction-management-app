import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { OFFICE_LIKE } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import Link from "next/link";
import { Camera, Clock, MessagesSquare, ClipboardList, CheckSquare } from "lucide-react";

export default async function FieldPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  const role = me.role;
  if (!OFFICE_LIKE.has(role as never)) redirect("/dashboard");
  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Field" subtitle="Crew photos, time, logs & RFIs" />
      <main className="max-w-md lg:max-w-5xl mx-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <Link href="/crew/photo" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <Camera className="w-5 h-5" />
            <span>Photos</span>
          </Link>
          <Link href="/crew/time" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <Clock className="w-5 h-5" />
            <span>Time</span>
          </Link>
          <Link href="/crew/daily-log" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <ClipboardList className="w-5 h-5" />
            <span>Daily Log</span>
          </Link>
          <Link href="/crew/punch" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <CheckSquare className="w-5 h-5" />
            <span>Punch List</span>
          </Link>
          <Link href="/crew/rfi" className="block bg-white border border-gray-300 text-gray-900 text-center py-3 rounded-lg font-semibold active:bg-gray-50 flex items-center justify-center gap-2">
            <MessagesSquare className="w-5 h-5" />
            <span>RFIs</span>
          </Link>
        </div>
      </main>
    </div>
  );
}