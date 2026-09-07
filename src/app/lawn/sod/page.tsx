import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import TopBar from "@/components/TopBar";
import SodCatalogue from "@/components/SodCatalogue";
import { listSodProducts } from "@/lib/sodProducts";

export const dynamic = "force-dynamic";

// Office sod catalog (lawn variant). The last catalogue without a screen: the
// contract and the estimate-side SodPanel both shipped, but nothing could edit
// a sod product, so every one of them sat at price 0 and the panel could only
// ever produce an unpriced line.
//
// PALLET SIZE IS THE FIELD THAT MATTERS HERE. Pallet count is sqft divided by
// sqft_per_pallet, so a zero does not yield a cautious estimate — it yields no
// order quantity at all. The manager counts and banners the ones that are
// missing it, which no other catalogue screen needs to do.
//
// Gate: requireRole(OFFICE_OR_PM) — matches the sod_products RLS tier
// (tier_office_or_pm) exactly (role-gate-mismatch pattern). Then a lawn-org
// gate: the estimator is lawn-only.
//
// The manager is a client component (inline CRUD needs the browser); this
// server shell seeds it with the org's sod via RLS through the sodProducts
// contract. All CRUD goes through src/lib/sodProducts.ts — no inline queries,
// no re-derived math.

export default async function SodCataloguePage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");
  if (me.appVariant !== "lawn") {
    const { redirect } = await import("next/navigation");
    redirect("/dashboard");
  }

  const supabase = await createClient();
  // activeOnly=false: the manager dims retired rows, so it needs them.
  const { data } = await listSodProducts(supabase, me.orgId ?? "", false);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <TopBar title="Sod" subtitle="Catalog" />
      <main className="max-w-md lg:max-w-7xl mx-auto p-4">
        <Suspense fallback={null}>
          <SodCatalogue initial={data} orgId={me.orgId ?? ""} />
        </Suspense>
      </main>
    </div>
  );
}
