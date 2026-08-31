import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import CrewTeamsManager from "./CrewTeamsManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { isLawn } from "@/lib/variant";

// Crew teams (lawn) — office/admin management. A crew_team is the unit work is
// assigned to; the lead confirms crew size at shift start, which is what
// converts recorded duration into priced man-hours. Same server-gate pattern as
// /lawn/ai: getMe + isSuperAdmin/isOfficeLike pair (the lawn nav audience for
// the office fallthrough block is office + admin only), no gate flash, no
// extra profiles round trip. /lawn is already blocked on the construction
// deploy by src/proxy.ts; the isLawn() check is defence in depth, not the gate.
export default async function LawnCrewsPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  if (!isLawn()) redirect("/dashboard");

  const role = me.role;
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");

  return (
    <PageContainer
      title="Crews"
      subtitle="Teams work is assigned to — the lead confirms head count at shift start"
      maxWidth="list"
    >
      <CrewTeamsManager orgId={me.orgId ?? ""} />
    </PageContainer>
  );
}