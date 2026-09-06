import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import EquipmentProductsManager from "@/components/EquipmentProductsManager";
import { listEquipment } from "@/lib/equipmentProducts";

export const dynamic = "force-dynamic";

// Office machinery catalog (lawn variant), Lane A of the UI handoff. The
// office/PM records the org's machines once — owned ones with an hourly
// internal rate, rented ones with daily/weekly/monthly rates plus delivery
// and pickup. Estimating machines is the estimator's side; this screen is the
// catalogue only.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the equipment RLS tier
// (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a lawn-org
// gate: the estimator is lawn-only.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's machines via RLS through the
// equipmentProducts contract. All CRUD goes through src/lib/equipmentProducts.ts
// — no inline queries, no re-derived math.

export default async function EquipmentCataloguePage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  // activeOnly=false: the manager dims retired rows, so it needs them.
  const { data } = await listEquipment(supabase, me.orgId ?? "", false);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Equipment" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <EquipmentProductsManager initial={data} orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}