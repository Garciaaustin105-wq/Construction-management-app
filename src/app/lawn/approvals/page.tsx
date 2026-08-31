import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import ApprovalsManager from "./ApprovalsManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { isLawn } from "@/lib/variant";

// Visits awaiting office approval (lawn) — gate 4 of the completion gates.
// Gates 1-3 (crew left and stayed gone, minimum on-site time) are enforced in
// the database; the office/admin queue is where a human says yes to sending
// "your yard is done". Office/admin only, gated like /lawn/crews: getMe +
// isSuperAdmin/isOfficeLike pair, no gate flash, no extra profiles round
// trip. /lawn is already blocked on the construction deploy by src/proxy.ts;
// the isLawn() check is defence in depth, not the gate.
export default async function LawnApprovalsPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  if (!isLawn()) redirect("/dashboard");

  const role = me.role;
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");

  return (
    <PageContainer
      title="Approvals"
      subtitle="Finished visits waiting for your sign-off before customers are told"
      maxWidth="list"
    >
      <ApprovalsManager />
    </PageContainer>
  );
}