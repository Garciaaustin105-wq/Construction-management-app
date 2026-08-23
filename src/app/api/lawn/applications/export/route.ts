import { createClient } from "@/lib/supabase/server";
import { getMe } from "@/lib/tenant";
import { OFFICE_OR_PM } from "@/lib/roles";
import { CSV_COLUMNS, csvEscape, type ChemicalApplication } from "@/lib/chemicals";

export const dynamic = "force-dynamic";

// Compliance CSV export — the audit record a state inspector asks for. Office
// / PM only (the list page + this route are the office surface; crew log via the
// POST route, not export). Reads via the RLS SESSION client, so office sees all
// of the org's applications (chem_app_office_all) and nothing cross-tenant.
// Optional ?from=&to= (ISO date or datetime) filters applied_at. Output is the
// stable CSV_COLUMNS layout from src/lib/chemicals.ts — keep it stable; the
// column order IS the audit shape.

export async function GET(request: Request) {
  const me = await getMe();
  if (!me) {
    return new Response("Not signed in", { status: 401 });
  }
  if (me.appVariant !== "lawn") {
    return new Response("Not available", { status: 403 });
  }
  const role = me.hasProfile ? me.role : null;
  if (!role || !OFFICE_OR_PM.has(role as never)) {
    return new Response("Not authorized", { status: 403 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const supabase = await createClient();
  let query = supabase
    .from("chemical_applications")
    .select(
      "id, organization_id, job_id, visit_id, product_id, product_name, epa_reg_number, active_ingredient, applicator_id, quantity_used, quantity_unit, rate, area_treated_sqft, target_pest, wind_mph, temp_f, applied_at, re_entry_hours, re_entry_until, notes, created_by, created_at, jobs(name, customers(name)), crew_members(name)"
    )
    .order("applied_at", { ascending: false });

  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) query = query.gte("applied_at", d.toISOString());
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) query = query.lte("applied_at", d.toISOString());
  }

  const { data, error } = await query;
  if (error) {
    return new Response(`Export failed: ${error.message}`, { status: 500 });
  }

  const rows = (data ?? []) as unknown as ChemicalApplication[];
  const header = CSV_COLUMNS.map((c) => csvEscape(c.label)).join(",");
  const body = rows
    .map((row) => CSV_COLUMNS.map((c) => csvEscape(c.get(row))).join(","))
    .join("\r\n");
  const csv = rows.length ? `${header}\r\n${body}` : header;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chemical-applications.csv"',
      "Cache-Control": "no-store",
    },
  });
}