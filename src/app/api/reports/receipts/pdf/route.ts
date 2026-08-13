import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import type { RowInput } from "jspdf-autotable";
import {
  fetchReceiptsReport,
  receiptTotals,
  type ReceiptReportFilters as Filters,
} from "@/lib/reports";

export const dynamic = "force-dynamic";

// Receipts report PDF — office only. Builds a tabular PDF of the filtered
// receipts with a clickable "View" photo link per row and a totals row.
//
// Uses jspdf + jspdf-autotable (pure JS, standard fonts embedded as data — no
// filesystem reads). The previous pdfkit implementation crashed on Vercel:
// pdfkit reads Helvetica.afm via `__dirname + '/data/...'` (string concat →
// double-slash path) which doesn't exist in the serverless bundle → ENOENT →
// 500 (foliojs/pdfkit issue #1516). jspdf has no such dependency. No embedded
// images — keeps the PDF small/fast; the on-screen table carries thumbnails.
// RLS scopes the query to the caller's org (user-scoped server client).
export async function GET(request: Request) {
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

  // 7-day signed URLs for the per-row "View" link.
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

  // Lookup friendly labels for the filters summary line.
  let jobLabel = "All jobs";
  let workerLabel = "Everyone";
  let codeLabel = "All codes";
  if (filters.jobId) {
    const { data: j } = await supabase.from("jobs").select("name").eq("id", filters.jobId).maybeSingle();
    if (j?.name) jobLabel = j.name;
  }
  if (filters.workerId) {
    const { data: p } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", filters.workerId)
      .maybeSingle();
    if (p?.full_name) workerLabel = p.full_name;
  }
  if (filters.costCodeId) {
    const { data: c } = await supabase
      .from("cost_codes")
      .select("code, name")
      .eq("id", filters.costCodeId)
      .maybeSingle();
    if (c) codeLabel = `${c.code} · ${c.name}`;
  }
  const dateLabel =
    filters.from || filters.to
      ? `${filters.from ?? "…"} → ${filters.to ?? "…"}`
      : "All dates";

  // Dynamic import keeps jspdf out of the static bundle and avoids any
  // browser-global references at module load on the server.
  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  // Per-body-row photo URLs (parallel to `body`), used to color the "View"
  // cell and to lay a clickable link region over it.
  const photoUrls: (string | null)[] = rows.map((r) => urlByPath.get(r.storage_path) ?? null);

  const head = [["Date", "User", "Job", "Location", "Vendor", "Amount", "Status", "Photo"]];

  const body = rows.map((r, i) => {
    const hasGps = typeof r.lat === "number" && typeof r.lng === "number";
    return [
      new Date(r.captured_at).toLocaleDateString(),
      r.uploaded_by_name ?? "—",
      r.job_name ?? "—",
      hasGps ? `${r.lat!.toFixed(4)}, ${r.lng!.toFixed(4)}` : "—",
      r.vendor ?? "—",
      `$${Number(r.amount ?? 0).toFixed(2)}`,
      r.reimbursed ? "Paid" : "Owed",
      photoUrls[i] ? "View" : "—",
    ];
  });

  const t = receiptTotals(rows);
  const foot: RowInput[] = [[
    { content: `TOTAL (${t.count} receipt${t.count === 1 ? "" : "s"})`, colSpan: 5, styles: { halign: "left", fillColor: [243, 244, 246], fontStyle: "bold" } },
    { content: `$${t.amount.toFixed(2)}`, styles: { halign: "right", fillColor: [243, 244, 246], fontStyle: "bold" } },
    { content: `Owed $${t.owed.toFixed(2)}   Paid $${t.paid.toFixed(2)}`, colSpan: 2, styles: { halign: "left", fillColor: [243, 244, 246], fontStyle: "bold" } },
  ]];

  const photoCol = 7;

  // Title + filters summary above the table.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(17, 24, 39);
  doc.text("Receipts Report", 40, 40);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text(`${jobLabel}  ·  ${workerLabel}  ·  ${codeLabel}  ·  ${dateLabel}`, 40, 56);

  autoTable(doc, {
    head,
    body,
    foot,
    startY: 72,
    margin: { left: 40, right: 40 },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [243, 244, 246], textColor: [107, 114, 128], fontStyle: "bold" },
    footStyles: { lineWidth: 0 },
    columnStyles: {
      5: { halign: "right" }, // Amount
    },
    didParseCell: (data) => {
      // Color the "View" link cell blue when a URL exists.
      if (data.section === "body" && data.column.index === photoCol) {
        const url = photoUrls[data.row.index];
        data.cell.styles.textColor = url ? [37, 99, 235] : [156, 163, 175];
      }
      // Status color.
      if (data.section === "body" && data.column.index === 6) {
        const paid = body[data.row.index][6] === "Paid";
        data.cell.styles.textColor = paid ? [4, 120, 87] : [234, 88, 12];
      }
    },
    didDrawCell: (data) => {
      // Lay a clickable link region over the "View" cell.
      if (data.section === "body" && data.column.index === photoCol) {
        const url = photoUrls[data.row.index];
        if (url) {
          doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
        }
      }
    },
  });

  const buf = doc.output("arraybuffer") as ArrayBuffer;
  const blob = new Blob([buf], { type: "application/pdf" });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(blob, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="receipts-report-${stamp}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}