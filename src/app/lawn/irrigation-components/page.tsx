import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import IrrigationComponentsManager from "@/components/IrrigationComponentsManager";
import { listComponents } from "@/lib/irrigationSystem";

export const dynamic = "force-dynamic";

// Irrigation COMPONENT catalogue (lawn variant), Lane D of the UI handoff:
// everything between the water source and the heads — POC, backflow, valves,
// controller, wire, mainline, sleeving. Heads live on /lawn/irrigation (a
// per-each model→nozzle catalogue); this screen is flat rows with an `each |
// foot` unit column, which is why it is a separate screen, not a tab.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the components RLS tier
// (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a lawn-org
// gate: the estimator is lawn-only.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's catalogue via RLS through the
// irrigationSystem contract. All CRUD goes through src/lib/irrigationSystem.ts —
// no inline queries, no re-derived math.

export default async function IrrigationComponentsPage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  // activeOnly=false: the manager dims retired rows, so it needs them — and
  // the seeded catalogue ships every part at price 0 (prices belong to the
  // org, not the seed), which the office has to be able to see to price.
  const { data } = await listComponents(supabase, me.orgId ?? "", false);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Components" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <IrrigationComponentsManager initial={data} orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}