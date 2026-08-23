import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import ChemicalApplicationsManager from "@/components/ChemicalApplicationsManager";
import type { ChemicalApplication } from "@/lib/chemicals";

export const dynamic = "force-dynamic";

// Office chemical-application log (lawn variant). The office/PM sees every
// application the org has logged (chem_app_office_all RLS), newest first, with
// the compliance fields + the customer/job/applicator joins. This is the
// audit surface — the CSV export button downloads the same rows in the
// stable CSV_COLUMNS layout for a state inspection.
//
// Logging a new application goes through POST /api/lawn/applications (NOT a
// client-side RLS insert), because the route does the compliance snapshot
// (copies product name + EPA # + active ingredient + re_entry_hours from the
// chosen product), computes re_entry_until, and enforces the crew gate
// (visit ownership). The office log form in the manager POSTs to it.
//
// Gate: requireRole(OFFICE_OR_PM) — matches chem_app_office_all (the office
// read/write policy). Crew have their own logging entry point (from a visit),
// not this page. Then a lawn-org gate: chemical tracking is lawn-only.
//
// The manager is a client component (the log form + filters need the browser);
// this server shell seeds it with the org's applications via RLS, embedding
// jobs(name, customers(name)) + crew_members(name) so the list shows the site +
// applicator without extra round-trips.

export default async function ChemicalApplicationsPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("chemical_applications")
    .select(
      "id, organization_id, job_id, visit_id, product_id, product_name, epa_reg_number, active_ingredient, applicator_id, quantity_used, quantity_unit, rate, area_treated_sqft, target_pest, wind_mph, temp_f, applied_at, re_entry_hours, re_entry_until, notes, created_by, created_at, jobs(name, customers(name)), crew_members(name)"
    )
    .order("applied_at", { ascending: false });

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Chemical Applications" subtitle="Log" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <ChemicalApplicationsManager
            initial={(data as ChemicalApplication[] | null) ?? []}
            orgId={me.orgId ?? ""}
          />
        </Suspense>
      </main>
    </div>
  );
}