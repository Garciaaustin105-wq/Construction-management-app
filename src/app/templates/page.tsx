import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import EstimateTemplatesManager, {
  type TemplateWithItems,
} from "@/components/EstimateTemplatesManager";

// Estimate Templates — office/PM management screen for reusable line-item
// templates. The estimate editor (EstimateLineItemEditor) already LOADS these
// onto an estimate and SAVES lines as a template; this page is the
// view/edit/delete surface. Both variants use it — no variant gate.
// Gate: requireRole(OFFICE_OR_PM), matching the template RLS (tier_office,
// same_org) — role-gate-mismatch pattern.
// CRUD is client-side through RLS (mirrors the lawn products page): the server
// shell only seeds the initial list.

export const dynamic = "force-dynamic";

export default async function EstimateTemplatesPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");

  const supabase = await createClient();
  const { data } = await supabase
    .from("estimate_templates")
    .select(
      "id, name, description, estimate_template_items(description, quantity, unit, unit_price, internal_cost, section, position)"
    )
    .order("name");

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Estimate Templates" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <EstimateTemplatesManager
            initial={(data as TemplateWithItems[] | null) ?? []}
            orgId={me.orgId ?? ""}
          />
        </Suspense>
      </main>
    </div>
  );
}