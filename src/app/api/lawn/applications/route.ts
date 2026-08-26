import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { OFFICE_OR_PM } from "@/lib/roles";
import { NextResponse } from "next/server";
import {
  computeReEntryUntil,
  type ChemicalApplicationInput,
} from "@/lib/chemicals";
import { checkApplicatorEligibility } from "@/lib/lawnApplicator";

export const dynamic = "force-dynamic";

// Log a chemical application. Office/PM may log anything (any job, any
// applicator, with or without a visit). Crew/superintendent may log ONLY on a
// visit assigned to them, and the route forces applicator_id = auth.uid()
// (they're the applicator). This mirrors the visit status route's crew gate.
//
// Compliance integrity: when product_id is supplied, the product's name + EPA
// reg # + active ingredient are SNAPSHOTTED onto the application row here
// (never read back from the product later), so editing/deleting a product
// never corrupts a historical record. A manual product_name (no product_id) is
// allowed for one-off products not in the catalog.
//
// Writes go through the RLS SESSION client — the policies admit office
// (chem_app_office_all) and crew (chem_app_crew_insert_own, applicator_id =
// auth.uid()). organization_id is stamped by the set_org_from_job() trigger
// (omit it from the insert). No service-role key needed.

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: Request) {
  const me = await getMe();
  if (!me) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (me.appVariant !== "lawn") {
    return NextResponse.json({ error: "Not available" }, { status: 403 });
  }
  const userId = me.user.id;
  const role = me.hasProfile ? me.role : null;
  const officeLike = !!role && OFFICE_OR_PM.has(role as never);
  const crewLike = role === "crew" || role === "superintendent";
  if (!officeLike && !crewLike) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  let body: Partial<ChemicalApplicationInput>;
  try {
    body = (await request.json()) as Partial<ChemicalApplicationInput>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  const productId =
    typeof body.product_id === "string" ? body.product_id.trim() : null;
  const manualName =
    typeof body.product_name === "string" ? body.product_name.trim() : "";

  if (!jobId) {
    return NextResponse.json({ error: "Job is required" }, { status: 400 });
  }
  if (!productId && !manualName) {
    return NextResponse.json(
      { error: "Select a product or enter a product name" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // 1) Product snapshot (when a catalog product is chosen). Crew can read the
  //    catalog (same_org_read policy), so the session client works for both.
  let productName = manualName;
  let epaReg: string | null =
    typeof body.epa_reg_number === "string" ? body.epa_reg_number.trim() || null : null;
  let activeIngredient: string | null =
    typeof body.active_ingredient === "string" ? body.active_ingredient.trim() || null : null;
  let reEntryHours = num(body.re_entry_hours);
  if (productId) {
    const { data: product } = await supabase
      .from("chemical_products")
      .select("name, epa_reg_number, active_ingredient, re_entry_hours")
      .eq("id", productId)
      .maybeSingle();
    const p = product as
      | {
          name: string;
          epa_reg_number: string | null;
          active_ingredient: string | null;
          re_entry_hours: number | null;
        }
      | null;
    if (!p) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    productName = p.name;
    epaReg = p.epa_reg_number;
    activeIngredient = p.active_ingredient;
    if (reEntryHours == null) reEntryHours = p.re_entry_hours;
  }

  // 2) Crew gate: crew may only log on a visit assigned to them, and the visit
  //    must belong to the same job. Office may link any visit (still validated
  //    to the same job so the record stays coherent).
  const visitId =
    typeof body.visit_id === "string" && body.visit_id.trim()
      ? body.visit_id.trim()
      : null;
  if (visitId) {
    const { data: visit } = await supabase
      .from("lawn_visits")
      .select("crew_id, job_id")
      .eq("id", visitId)
      .maybeSingle();
    const v = visit as { crew_id: string | null; job_id: string } | null;
    if (!v) {
      return NextResponse.json({ error: "Visit not found" }, { status: 404 });
    }
    if (v.job_id !== jobId) {
      return NextResponse.json(
        { error: "Visit does not belong to this job" },
        { status: 400 }
      );
    }
    if (crewLike && v.crew_id !== userId) {
      return NextResponse.json(
        { error: "Not your visit" },
        { status: 403 }
      );
    }
  } else if (crewLike) {
    return NextResponse.json(
      { error: "Crew must log an application from an assigned visit" },
      { status: 403 }
    );
  }

  // 3) applicator_id: forced to the caller for crew; office may assign anyone.
  const applicatorId = crewLike ? userId : (body.applicator_id?.trim() || null);

  // 3b) Applicator license enforcement (audit §4.1). A regulated application
  //     is the artifact a state regulator reads, so it must not be logged under
  //     an applicator with no license or an expired one. Crew IS the applicator
  //     (forced above), so a crew member with an expired/no license is blocked
  //     from logging — the office reassigns the application to a licensed
  //     applicator instead. crew_members SELECT is same_org-scoped (not
  //     self-only), so the session client reads any applicator's license.
  //     An unassigned applicator (office left applicator_id blank) is allowed
  //     for now — it's a separate "named but unlicensed" vs "no applicator"
  //     distinction; the dashboard widget surfaces license coverage separately.
  if (applicatorId) {
    const { data: applicator } = await supabase
      .from("crew_members")
      .select("applicator_license_number, applicator_license_expires")
      .eq("id", applicatorId)
      .maybeSingle();
    const a = applicator as
      | {
          applicator_license_number: string | null;
          applicator_license_expires: string | null;
        }
      | null;
    const eligibility = checkApplicatorEligibility({
      licenseNumber: a?.applicator_license_number ?? null,
      licenseExpires: a?.applicator_license_expires ?? null,
    });
    if (eligibility.severity === "block") {
      return NextResponse.json(
        { error: `Cannot log application: ${eligibility.reason}` },
        { status: 400 }
      );
    }
  }

  // 4) applied_at + re_entry_until.
  const appliedAt =
    typeof body.applied_at === "string" && body.applied_at.trim()
      ? new Date(body.applied_at).toISOString()
      : new Date().toISOString();
  if (Number.isNaN(new Date(appliedAt).getTime())) {
    return NextResponse.json({ error: "Invalid applied_at" }, { status: 400 });
  }
  const reEntryUntil = computeReEntryUntil(appliedAt, reEntryHours);

  // 5) Insert (RLS admits office via chem_app_office_all, crew via
  //    chem_app_crew_insert_own because applicator_id = auth.uid()). Org is
  //    stamped by the trigger from job_id — omit organization_id.
  const insert: Record<string, unknown> = {
    job_id: jobId,
    visit_id: visitId,
    product_id: productId,
    product_name: productName,
    epa_reg_number: epaReg,
    active_ingredient: activeIngredient,
    applicator_id: applicatorId,
    quantity_used: num(body.quantity_used),
    quantity_unit: typeof body.quantity_unit === "string" ? body.quantity_unit : null,
    rate: num(body.rate),
    area_treated_sqft: num(body.area_treated_sqft),
    target_pest:
      typeof body.target_pest === "string" ? body.target_pest.trim() || null : null,
    wind_mph: num(body.wind_mph),
    temp_f: num(body.temp_f),
    applied_at: appliedAt,
    re_entry_hours: reEntryHours,
    re_entry_until: reEntryUntil,
    notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
    created_by: userId,
  };

  const { data, error } = await supabase
    .from("chemical_applications")
    .insert(insert)
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: `Could not log application: ${error?.message ?? "error"}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, id: (data as { id: string }).id }, { status: 201 });
}