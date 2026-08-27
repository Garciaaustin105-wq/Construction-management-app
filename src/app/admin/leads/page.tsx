import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import PageContainer from "@/components/PageContainer";
import LeadsBoard from "@/components/LeadsBoard";
import type { Lead } from "@/lib/leads";

export const dynamic = "force-dynamic";

// Office lead pipeline board (lawn variant). The office manages pre-customer
// prospects here: a drag-drop Kanban across the 5 stages (new → contacted →
// quoted → won | lost), with lead→customer conversion at the wall (the
// existing guard_customer_create cap = the upgrade nudge).
//
// Gate: requireRole(OFFICE_OR_PM) — matches the leads RLS policy
// (tier_office_or_pm) exactly, so the page gate and the data gate never drift
// (the role-gate-mismatch pattern). Then a lawn-org gate: only lawn orgs have
// a lead pipeline for launch (construction opts in later by generating tokens
// — no schema change), so a non-lawn org that reaches here is redirected.
//
// The board is a client component (drag-drop needs the browser); this server
// shell seeds it with the org's leads via RLS (the session client is
// org-scoped by the policy), mirroring /admin/customers. CRUD is client-side
// through RLS — no /api/leads/[id] endpoint, just like customers.

export default async function LeadsPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    // Launch scope: leads are lawn-only. Construction orgs get the pipeline
    // later (generate lead_form_tokens, no schema change). For now redirect.
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select(
      "id, organization_id, name, contact_name, email, phone, address, service_interest, source, referral_detail, referred_by_customer_id, status, assigned_to, notes, converted_customer_id, converted_at, created_at, created_by, estimate_id"
    )
    .order("created_at", { ascending: false });

  // The org's public lead-form token (separate read — deliberately NOT threaded
  // through get_my_tenant(), whose fixed returns-table signature would need a
  // DROP+CREATE on the login path; same trade-off as business_types). The board
  // uses it to offer a "copy lead form link" (/lead/{token}) the office shares
  // on their site / Google Business Profile. RLS scoping guarantees the row.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("lead_form_token")
    .eq("id", me.orgId ?? "")
    .maybeSingle();
  const leadFormToken =
    (orgRow as unknown as { lead_form_token: string | null } | null)
      ?.lead_form_token ?? null;

  return (
    <PageContainer title="Leads" subtitle="Pipeline" maxWidth="full">
      <Suspense fallback={null}>
        <LeadsBoard
          initial={(data as Lead[] | null) ?? []}
          orgId={me.orgId ?? ""}
          leadFormToken={leadFormToken}
        />
      </Suspense>
    </PageContainer>
  );
}