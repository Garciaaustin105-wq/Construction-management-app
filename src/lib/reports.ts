// Shared report query helpers — single source of truth for the receipts report
// so the on-screen page, the Excel export, and the PDF export all read the
// exact same filtered set. Server-only (uses the user-scoped server client so
// RLS scopes every query to the caller's org — no service role).

import type { SupabaseClient } from "@supabase/supabase-js";
import { startOfWeek, addDays } from "@/lib/weekUtils";

export type ReceiptReportFilters = {
  jobId?: string | null;
  workerId?: string | null;
  costCodeId?: string | null;
  // YYYY-MM-DD strings (local). `to` is treated as INCLUSIVE (through end of
  // that calendar day).
  from?: string | null;
  to?: string | null;
};

export type ReceiptReportRow = {
  id: string;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  captured_at: string;
  vendor: string | null;
  amount: number | null;
  tax: number | null;
  category: string | null;
  payment_method: string | null;
  receipt_no: string | null;
  reimbursed: boolean | null;
  reimbursed_at: string | null;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  location_source: string | null;
  cost_code_id: string | null;
  job_name: string | null;
  cost_code_label: string | null; // "CODE · Name" or null
};

// next-day midnight ISO for an inclusive `to` date filter (captured_at < this).
function endOfDayISO(to: string): string {
  const d = new Date(`${to}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export async function fetchReceiptsReport(
  supabase: SupabaseClient,
  filters: ReceiptReportFilters,
  opts?: { limit?: number }
): Promise<ReceiptReportRow[]> {
  let q = supabase
    .from("receipts")
    .select(
      "id, storage_path, uploaded_by, uploaded_by_name, captured_at, vendor, amount, tax, category, payment_method, receipt_no, reimbursed, reimbursed_at, notes, lat, lng, location_source, cost_code_id, job:jobs(name), cost_code:cost_codes(code, name)"
    );

  if (filters.jobId) q = q.eq("job_id", filters.jobId);
  if (filters.workerId) q = q.eq("uploaded_by", filters.workerId);
  if (filters.costCodeId) q = q.eq("cost_code_id", filters.costCodeId);
  if (filters.from) q = q.gte("captured_at", new Date(`${filters.from}T00:00:00`).toISOString());
  if (filters.to) {
    const end = endOfDayISO(filters.to);
    if (end) q = q.lt("captured_at", end);
  }

  // Cap the on-screen table (opts.limit) because it mints a transformed
  // thumbnail per row — createSignedUrls doesn't support `transform`, so it's
  // one request per path and bounding the page keeps N small. The Excel/PDF
  // exports call this without a limit so they include every matching receipt.
  q = q.order("captured_at", { ascending: true });
  if (opts?.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) return [];

  return (data ?? []).map((r) => {
    const row = r as unknown as {
      id: string;
      storage_path: string;
      uploaded_by: string | null;
      uploaded_by_name: string | null;
      captured_at: string;
      vendor: string | null;
      amount: number | null;
      tax: number | null;
      category: string | null;
      payment_method: string | null;
      receipt_no: string | null;
      reimbursed: boolean | null;
      reimbursed_at: string | null;
      notes: string | null;
      lat: number | null;
      lng: number | null;
      location_source: string | null;
      cost_code_id: string | null;
      job: { name: string | null } | null;
      cost_code: { code: string; name: string } | null;
    };
    return {
      id: row.id,
      storage_path: row.storage_path,
      uploaded_by: row.uploaded_by,
      uploaded_by_name: row.uploaded_by_name,
      captured_at: row.captured_at,
      vendor: row.vendor,
      amount: row.amount,
      tax: row.tax,
      category: row.category,
      payment_method: row.payment_method,
      receipt_no: row.receipt_no,
      reimbursed: row.reimbursed,
      reimbursed_at: row.reimbursed_at,
      notes: row.notes,
      lat: row.lat,
      lng: row.lng,
      location_source: row.location_source,
      cost_code_id: row.cost_code_id,
      job_name: row.job?.name ?? null,
      cost_code_label: row.cost_code
        ? `${row.cost_code.code} · ${row.cost_code.name}`
        : null,
    };
  });
}

// Shared totals for the receipts report — used by the page tfoot, Excel, PDF.
export function receiptTotals(rows: ReceiptReportRow[]) {
  let amount = 0;
  let tax = 0;
  let owed = 0;
  let paid = 0;
  for (const r of rows) {
    const a = Number(r.amount ?? 0);
    const t = Number(r.tax ?? 0);
    amount += a;
    tax += t;
    if (r.reimbursed) paid += a;
    else owed += a;
  }
  return { count: rows.length, amount, tax, owed, paid };
}

// Resolve a report date range from ?from/&to (YYYY-MM-DD) with a legacy
// ?weekStart fallback (one Monday–Sunday week). Defaults to the current week.
// Returns local-midnight Dates; `toInclusive` is the LAST day of the range.
// Used by the per-worker report page + route so they always agree on the range.
export function resolveReportRange(
  from?: string | null,
  to?: string | null,
  weekStart?: string | null
): { from: Date; toInclusive: Date } {
  const defFrom = startOfWeek(new Date());
  const defTo = addDays(defFrom, 6);

  let f = from ? new Date(`${from}T00:00:00`) : defFrom;
  let t = to ? new Date(`${to}T00:00:00`) : defTo;

  // Legacy: a bare ?weekStart with no from/to → that Monday–Sunday week.
  if (weekStart && !from && !to) {
    const ws = startOfWeek(new Date(`${weekStart}T00:00:00`));
    if (!Number.isNaN(ws.getTime())) {
      f = ws;
      t = addDays(ws, 6);
    }
  }

  if (Number.isNaN(f.getTime())) f = defFrom;
  if (Number.isNaN(t.getTime())) t = defTo;
  if (f.getTime() > t.getTime()) {
    const tmp = f;
    f = t;
    t = tmp;
  }
  return { from: f, toInclusive: t };
}

// Whole-day span between two local-midnight dates (inclusive end). Used to
// decide whether the per-day Daily Hours grid is practical (cap at 31).
export function rangeDayCount(from: Date, toInclusive: Date): number {
  return Math.round((toInclusive.getTime() - from.getTime()) / 86_400_000) + 1;
}