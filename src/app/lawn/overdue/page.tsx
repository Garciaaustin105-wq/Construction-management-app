import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PageContainer from "@/components/PageContainer";
import OverdueManager from "./OverdueManager";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { isLawn } from "@/lib/variant";
import { DEFAULT_TIME_ZONE } from "@/lib/orgDate";

// Overdue backlog (lawn) — pending visits past their due date, oldest first.
// Same server-gate pattern as /lawn/crews: getMe + isSuperAdmin/isOfficeLike
// pair (the lawn nav audience that gets this tab is office + admin only).
// /lawn is already blocked on the construction deploy by src/proxy.ts; the
// isLawn() check is defence in depth, not the gate.
//
// The zone matters: "how late is it" is the org's calendar question, not the
// Vercel server's (UTC) — the old toISOString() "today" moved every evening
// from 20:00 Eastern.
export default async function LawnOverduePage() {
  const me = await getMe();
  if (!me) redirect("/login");

  if (!isLawn()) redirect("/dashboard");

  const role = me.role;
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");

  // Org zone — one small read up front (the client list query below filters
  // on the today string this produces, so it must exist before render).
  let timeZone: string | null = null;
  if (me.orgId) {
    const supabase = await createClient();
    const { data: orgTzRow } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", me.orgId)
      .maybeSingle();
    timeZone = (orgTzRow as { timezone: string | null } | null)?.timezone ?? null;
  }

  return (
    <PageContainer
      title="Overdue"
      subtitle="Pending visits past their due date — oldest first"
      maxWidth="list"
    >
      <OverdueManager timeZone={timeZone ?? DEFAULT_TIME_ZONE} />
    </PageContainer>
  );
}