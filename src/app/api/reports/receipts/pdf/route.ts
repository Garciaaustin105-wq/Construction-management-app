import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import PDFDocument from "pdfkit";
import {
  fetchReceiptsReport,
  receiptTotals,
  type ReceiptReportFilters as Filters,
} from "@/lib/reports";

export const dynamic = "force-dynamic";

// Receipts report PDF — office only. Builds a tabular PDF (pdfkit) of the
// filtered receipts with a clickable "View" photo link per row and a totals
// row. No embedded images — keeps the PDF small/fast and avoids image-fetch
// timeouts (the on-screen table carries the actual thumbnails). RLS scopes the
// query to the caller's org.
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

  // ── Build the PDF ───────────────────────────────────────────────────────
  const margin = 36;
  const doc = new PDFDocument({ size: "letter", layout: "landscape", margins: { top: margin, bottom: margin, left: margin, right: margin } });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const pageW = 792;
  const pageH = 612;
  const usableW = pageW - margin * 2;

  // Column definitions: x is absolute from left margin; w is column width.
  const cols = [
    { key: "date", label: "Date", x: margin, w: 58, align: "left" as const },
    { key: "user", label: "User", x: margin + 58, w: 78, align: "left" as const },
    { key: "job", label: "Job", x: margin + 136, w: 110, align: "left" as const },
    { key: "loc", label: "Location", x: margin + 246, w: 120, align: "left" as const },
    { key: "vendor", label: "Vendor", x: margin + 366, w: 90, align: "left" as const },
    { key: "amount", label: "Amount", x: margin + 456, w: 64, align: "right" as const },
    { key: "status", label: "Status", x: margin + 520, w: 78, align: "left" as const },
    { key: "photo", label: "Photo", x: margin + 598, w: usableW - 562, align: "left" as const },
  ];

  const rowH = 16;
  const headerH = 18;

  function clip(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  function drawHeader(y: number): number {
    doc.font("Helvetica-Bold").fontSize(8);
    doc.rect(margin, y - 2, usableW, headerH).fill("#f3f4f6");
    for (const c of cols) {
      doc.fillColor("#6b7280").text(c.label, c.x, y, { width: c.w, align: c.align });
    }
    doc.fillColor("#000000");
    return y + headerH;
  }

  // Title + filters summary.
  let y = margin;
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text("Receipts Report", margin, y);
  y += 22;
  doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
  doc.text(
    `${jobLabel}  ·  ${workerLabel}  ·  ${codeLabel}  ·  ${dateLabel}`,
    margin,
    y,
    { width: usableW }
  );
  y += 16;

  // Table header.
  y = drawHeader(y + 4);
  doc.font("Helvetica").fontSize(8).fillColor("#111827");

  const maxBottom = pageH - margin - rowH;

  for (const r of rows) {
    if (y > maxBottom) {
      doc.addPage();
      y = drawHeader(margin);
      doc.font("Helvetica").fontSize(8).fillColor("#111827");
    }

    const url = urlByPath.get(r.storage_path);
    const hasGps = typeof r.lat === "number" && typeof r.lng === "number";
    const cells: Record<string, string> = {
      date: new Date(r.captured_at).toLocaleDateString(),
      user: clip(r.uploaded_by_name ?? "—", 14),
      job: clip(r.job_name ?? "—", 20),
      loc: hasGps ? `${r.lat!.toFixed(4)}, ${r.lng!.toFixed(4)}` : "—",
      vendor: clip(r.vendor ?? "—", 16),
      amount: `$${Number(r.amount ?? 0).toFixed(2)}`,
      status: r.reimbursed ? "Paid" : "Owed",
      photo: url ? "View" : "—",
    };

    for (const c of cols) {
      if (c.key === "photo" && url) {
        doc.fillColor("#2563eb").text("View", c.x, y, { width: c.w, align: "left", link: url, underline: true });
        doc.fillColor("#111827");
      } else if (c.key === "status") {
        doc.fillColor(r.reimbursed ? "#047857" : "#ea580c").text(cells[c.key], c.x, y, { width: c.w, align: c.align });
        doc.fillColor("#111827");
      } else if (c.key === "amount") {
        doc.text(cells[c.key], c.x, y, { width: c.w, align: "right" });
      } else {
        doc.text(cells[c.key], c.x, y, { width: c.w, align: c.align });
      }
    }
    // Faint separator line.
    doc.moveTo(margin, y + rowH - 2).lineTo(margin + usableW, y + rowH - 2).strokeColor("#f3f4f6").lineWidth(0.5).stroke();
    y += rowH;
  }

  // Totals row.
  if (y > maxBottom) {
    doc.addPage();
    y = margin;
  }
  const t = receiptTotals(rows);
  y += 4;
  doc.rect(margin, y - 2, usableW, headerH).fill("#f3f4f6");
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827");
  doc.text(`TOTAL (${t.count} receipt${t.count === 1 ? "" : "s"})`, cols[0].x, y, { width: cols[1].x - cols[0].x + cols[1].w });
  doc.text(`$${t.amount.toFixed(2)}`, cols[5].x, y, { width: cols[5].w, align: "right" });
  doc.fillColor("#ea580c").text(`Owed $${t.owed.toFixed(2)}`, cols[6].x, y, { width: cols[6].w });
  doc.fillColor("#047857").text(`Paid $${t.paid.toFixed(2)}`, cols[7].x, y, { width: cols[7].w });

  doc.end();
  const buf = await done;
  const blob = new Blob([new Uint8Array(buf)], { type: "application/pdf" });

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