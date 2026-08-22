import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import {
  fetchReceiptsReport,
  receiptTotals,
  type ReceiptReportFilters as Filters,
} from "@/lib/reports";

export const dynamic = "force-dynamic";

// Receipts report — office only. Streams a real .xlsx workbook of the filtered
// receipts (one row per receipt) with a clickable photo link per row and a
// totals row. Mirrors the weekly report route's SheetJS + gate pattern. RLS
// scopes the query to the caller's org (user-scoped server client, no service
// role).
export async function GET(request: Request) {
  const XLSX = await import("xlsx");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "office" && profile?.role !== "admin") {
    return NextResponse.json({ error: "Office only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const filters: Filters = {
    jobId: searchParams.get("job") || null,
    workerId: searchParams.get("worker") || null,
    costCodeId: searchParams.get("code") || null,
    from: searchParams.get("from") || null,
    to: searchParams.get("to") || null,
  };

  const rows = await fetchReceiptsReport(supabase, filters);

  // Mint long-lived (7-day) signed URLs for the photo link column so the
  // downloaded workbook stays openable for a week. Batch mint by unique path.
  const paths = [...new Set(rows.map((r) => r.storage_path))];
  const urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("receipts")
      .createSignedUrls(paths, 60 * 60 * 24 * 7);
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) urlByPath.set(s.path, s.signedUrl);
    }
  }

  const loc = (r: (typeof rows)[number]) =>
    typeof r.lat === "number" && typeof r.lng === "number"
      ? `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}${r.location_source ? ` (${r.location_source})` : ""}`
      : "—";

  const aoa: (string | number)[][] = [
    [
      "Date",
      "User",
      "Job",
      "Location",
      "Vendor",
      "Amount $",
      "Tax $",
      "Category",
      "Payment Method",
      "Receipt No",
      "Cost Code",
      "Paid Back",
      "Reimbursed At",
      "Notes",
      "Photo",
    ],
  ];
  for (const r of rows) {
    aoa.push([
      new Date(r.captured_at).toLocaleDateString(),
      r.uploaded_by_name ?? "—",
      r.job_name ?? "—",
      loc(r),
      r.vendor ?? "",
      Number(r.amount ?? 0),
      r.tax != null ? Number(r.tax) : 0,
      r.category ?? "",
      r.payment_method ?? "—",
      r.receipt_no ?? "—",
      r.cost_code_label ?? "—",
      r.reimbursed ? "Yes" : "No",
      r.reimbursed_at ? new Date(r.reimbursed_at).toLocaleDateString() : "—",
      r.notes ?? "",
      urlByPath.get(r.storage_path) ?? "",
    ]);
  }

  const t = receiptTotals(rows);
  aoa.push([
    `TOTAL (${t.count})`,
    "",
    "",
    "",
    "",
    t.amount,
    t.tax,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Turn the Photo column cells into clickable hyperlinks.
  const photoCol = 14;
  for (let i = 1; i <= rows.length; i++) {
    const cell = ws[XLSX.utils.encode_cell({ r: i, c: photoCol })];
    if (cell && typeof cell.v === "string" && cell.v.startsWith("http")) {
      cell.l = { Target: cell.v };
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, "Receipts");

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="receipts-report-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}