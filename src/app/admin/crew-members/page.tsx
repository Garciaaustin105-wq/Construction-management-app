import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import TopBar from "@/components/TopBar";
import CrewMembersManager from "@/components/CrewMembersManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

// Office-only management of the org's crew roster. A crew_member is either:
//  - linked (user_id set): a real app-user crew/superintendent, auto-synced from
//    profiles by the sync_crew_member_from_profile trigger; office can remove
//    them from the crew pool but not rename them (the profile owns the name).
//  - scheduling-only (user_id null): a crew member who never logs in — the
//    office assigns + marks their visits done. This is the "not tech-savvy /
//    doesn't want the app" path. See crew_members.sql.
export default async function CrewMembersPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  const role = me.role;
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");
  const orgId = me.orgId ?? "";

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Crew Members" subtitle="Crew roster for scheduling" />
      <main className="max-w-md lg:max-w-3xl mx-auto p-4">
        <CrewMembersManager orgId={orgId} />
      </main>
    </div>
  );
}