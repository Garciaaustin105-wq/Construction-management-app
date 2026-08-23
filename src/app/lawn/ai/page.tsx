import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { redirect } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import AiAdminClient, { type CustomerOption } from "./AiAdminClient";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { isLawn } from "@/lib/variant";

export const dynamic = "force-dynamic";

// AI admin (lawn variant) — the office-facing half of the "AI-native lawn CRM"
// differentiator. Slice 1 is one feature end-to-end: summarize this org's lawn
// visits for a period.
//
// ── ROLE GATE ──────────────────────────────────────────────────────────────
// office + admin only; super_admin bounces. Derived from the LAWN nav audience
// in src/lib/navItems.ts, not guessed:
//   • The lawn branch of navItems returns EARLY for crew/superintendent (base +
//     Route), project_manager (base only — Home/Photos/Time), sales
//     (/estimates funnel), accountant (/invoices), and super_admin
//     (platform-only). The office-surface list — Customers, Leads, Reviews,
//     Applications, Insights, Notifications — is the FALLTHROUGH block, so on
//     lawn it is reached by office and admin ONLY.
//   • project_manager therefore has NO lawn office surfaces in nav. The handoff
//     suggested OFFICE_OR_PM; that would admit PM to a page their nav never
//     shows them. Flagged rather than adopted — see the report.
//   • super_admin has a null org. checkAiQuota(orgId) and every visit read here
//     are org-scoped, and same_org() short-circuits true for super_admin, so
//     admitting it would aggregate every tenant's data. Same treatment as
//     /lawn and the /dashboard notifications feed.
// Expressed with the isSuperAdmin/isOfficeLike pair that /admin/cost-codes,
// /admin/crew-members and /admin/isp/plans already use, so it can't drift.
//
// This is a SERVER page that gates and then renders a client island. The
// handoff pointed at /lawn/notifications (client-side gate) as the pattern; a
// server gate is used instead because it decides before any markup ships (no
// gate flash), needs no extra profiles round trip, and keeps the super_admin
// bounce authoritative. The interactive form is the client component.

export default async function LawnAiPage() {
  const me = await getMe();
  if (!me) redirect("/login");

  // Lawn-only feature. src/proxy.ts already blocks the whole "/lawn" prefix on
  // the construction deploy (LAWN_BLOCKED_PAGE_PREFIXES), so this line is
  // defence in depth rather than the only gate — it keeps the page correct if
  // that prefix list is ever narrowed.
  if (!isLawn()) redirect("/dashboard");

  const role = me.role;
  if (isSuperAdmin(role) || !isOfficeLike(role)) redirect("/dashboard");
  if (!me.orgId) redirect("/dashboard");

  // Customer picker options. Read with the SESSION client, so RLS scopes this
  // to the caller's org exactly as it does on /lawn/new — no new access
  // decision, and nothing here needs the service role.
  const supabase = await createClient();
  const { data } = await supabase
    .from("customers")
    .select("id, name")
    .order("name");

  const customers = ((data ?? []) as { id: string; name: string | null }[])
    .filter((c): c is CustomerOption => !!c.name)
    .map((c) => ({ id: c.id, name: c.name }));

  return (
    <PageContainer
      title="AI admin"
      subtitle="Summaries and drafts from your own job data"
      maxWidth="list"
    >
      <AiAdminClient customers={customers} />
    </PageContainer>
  );
}
