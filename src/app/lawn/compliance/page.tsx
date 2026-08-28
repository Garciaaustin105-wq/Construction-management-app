/**
 * Compliance page (lawn variant)
 *
 * Fetches all chemical compliance data and renders the ComplianceRecordsManager.
 */

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/server-gate";
import { OFFICE_OR_PM } from "@/lib/roles";
import PageContainer from "@/components/PageContainer";
import ComplianceRecordsManager, {
  type ComplianceProduct,
  type ComplianceCrew,
  type RupPurchaseRow,
  type DisposalRow,
  type CeuRow,
  type TrainingRow,
  type UnsharedRupRow,
} from "@/components/ComplianceRecordsManager";

export const dynamic = "force-dynamic";

export default async function CompliancePage() {
  const me = await requireRole(OFFICE_OR_PM, "/dashboard");

  const supabase = await createClient();

  const [
    { data: productData },
    { data: crewData },
    { data: purchaseData },
    { data: disposalData },
    { data: ceuData },
    { data: trainingData },
  ] = await Promise.all([
    supabase
      .from("chemical_products")
      .select("id, name, is_restricted_use")
      .order("name"),
    supabase
      .from("crew_members")
      .select("id, name")
      .order("name"),
    supabase
      .from("rup_purchases")
      .select("*")
      .order("purchase_date", { ascending: false }),
    supabase
      .from("chemical_disposal_records")
      .select("*")
      .order("disposal_date", { ascending: false }),
    supabase
      .from("applicator_ceu_records")
      .select("*")
      .order("completed_date", { ascending: false }),
    supabase
      .from("noncertified_applicator_training")
      .select("*")
      .order("training_completed_date", { ascending: false }),
  ]);

  // Unshared RUP: two queries
  const { data: restrictedIds } = await supabase
    .from("chemical_products")
    .select("id")
    .eq("is_restricted_use", true);
  const idList = restrictedIds?.map((p: { id: string }) => p.id) ?? [];
  const { data: unsharedAppData } = await supabase
    .from("chemical_applications")
    .select("id, product_id, quantity_used, created_at")
    .is("shared_at", null)
    .in("product_id", idList)
    .order("created_at", { ascending: true })
    .limit(50);

  const productNameById = new Map<string, string>();
  (productData ?? []).forEach((p: { id: string; name: string }) => productNameById.set(p.id, p.name));

  const unsharedRup: UnsharedRupRow[] = (unsharedAppData ?? []).map((row: { id: string; product_id: string; quantity_used: number | null; created_at: string }) => ({
    id: row.id,
    product_name: productNameById.get(row.product_id) ?? null,
    quantity_used: row.quantity_used,
    created_at: row.created_at,
  }));

  const props = {
    orgId: me.orgId ?? "",
    products: (productData ?? []) as ComplianceProduct[],
    crews: (crewData ?? []) as ComplianceCrew[],
    rupPurchases: (purchaseData ?? []) as RupPurchaseRow[],
    disposals: (disposalData ?? []) as DisposalRow[],
    ceuRecords: (ceuData ?? []) as CeuRow[],
    trainingRecords: (trainingData ?? []) as TrainingRow[],
    unsharedRup,
  };

  return (
    <PageContainer
      title="Compliance"
      subtitle="Chemical records"
      backHref="/lawn"
      backLabel="Back"
      maxWidth="list"
      mainClassName="space-y-6"
    >
      <ComplianceRecordsManager {...props} />
    </PageContainer>
  );
}
