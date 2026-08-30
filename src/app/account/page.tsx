import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import AccountMfaManager from "@/components/AccountMfaManager";

// The app's first personal (not org-level) account settings page — open to
// ANY authenticated role, not gated by OFFICE_LIKE/requireRole. /manage is
// org-level admin settings; this is "your own account," so a crew member or
// customer can secure their own login the same as an office admin.
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Account" subtitle={me.user.email ?? undefined} />
      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        <AccountMfaManager />
      </main>
    </div>
  );
}
