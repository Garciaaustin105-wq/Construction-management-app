import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { deliverInvoice } from "@/lib/invoiceSend";
import { sendEstimateDecisionEmail } from "@/lib/email";
import { createInvoiceFromEstimate } from "@/lib/estimateInvoice";
import {
  computeEstimateTotals,
  formatMoney,
  type EstimatePricing,
} from "@/lib/money";

export const dynamic = "force-dynamic";

// Authed-customer e-signature for a proposal estimate — the keystone of the
// Proposals feature. The customer (signed in via Client Portal magic link)
// submits their typed name + drawn signature. This route:
//   1. confirms ownership via RLS (session client) + validates the payload,
//   2. uploads the drawn signature PNG to the private `proposal-docs` bucket,
//   3. runs the SECURITY DEFINER `sign_proposal` RPC (guards: customer account,
//      owning customer, same_org, status='sent', requires_signature) → inserts
//      a portal_approvals row + flips estimates to 'approved' atomically,
//   4. generates a signed PDF (jspdf) embedding the typed name + drawn signature
//      + timestamp + signer IP + org header + line items + pricing + terms,
//   5. uploads the PDF + links it on portal_approvals.signed_pdf_path +
//      estimates.signed_proposal_url,
//   6. creates the construction invoice (deposit-only or full, same shape as
//      the public approve flow) + auto-delivers it + notifies the office.
//
// Auth split: RLS session client for the auth check + the ownership-scoped read;
// service-role admin for every write (signature upload, RPC, PDF upload, the
// path updates, invoice, notifications). The RPC is the authority on the
// signature's legality — TS-side work only persists artifacts the RPC already
// authorized.

function requestOrigin(request: Request): string {
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return "localhost";
      }
    })();
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

function signerIp(request: Request): string | null {
  const xf = request.headers.get("x-forwarded-for");
  if (!xf) return null;
  const first = xf.split(",")[0]?.trim();
  return first || null;
}

// Fit a source (w×h) into a max box preserving aspect (for the signature image
// in the PDF — never stretch a legal mark).
function fitBox(
  w: number,
  h: number,
  maxW: number,
  maxH: number
): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: maxW, h: maxH };
  const ar = w / h;
  let rw = maxW;
  let rh = maxW / ar;
  if (rh > maxH) {
    rh = maxH;
    rw = maxH * ar;
  }
  return { w: Math.round(rw), h: Math.round(rh) };
}

// Parse a #rrggbb hex to an [r,g,b] triple for jspdf's numeric setFillColor
// (passing the hex string is inconsistent across jspdf builds; numeric RGB is
// always safe). Falls back to slate-800 on a malformed value.
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [30, 41, 59];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // ── 1. Parse + validate the payload ───────────────────────────────────────
  let body: {
    signatureText?: string;
    signatureImageDataUrl?: string;
    signatureWidth?: number;
    signatureHeight?: number;
    signerName?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const signatureText = (body.signatureText ?? "").trim();
  const signerName = (body.signerName ?? "").trim();
  const dataUrl = body.signatureImageDataUrl ?? "";
  if (!signatureText) {
    return NextResponse.json(
      { error: "Your typed name is required." },
      { status: 400 }
    );
  }
  if (!signerName) {
    return NextResponse.json(
      { error: "Signer name is required." },
      { status: 400 }
    );
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    return NextResponse.json(
      { error: "A drawn signature image is required." },
      { status: 400 }
    );
  }
  const sigW = Number(body.signatureWidth) || 0;
  const sigH = Number(body.signatureHeight) || 0;

  // ── 2. Auth + ownership-scoped read (RLS session client) ──────────────────
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("customer_id, full_name, role")
    .eq("id", user.id)
    .maybeSingle();
  const customerId = profile?.customer_id ?? null;
  if (!customerId) {
    return NextResponse.json(
      { error: "Only client portal accounts may sign proposals." },
      { status: 403 }
    );
  }

  // Scoped by customer_id + requires_signature + status='sent'. RLS also
  // enforces same-org + customer-own, but the explicit filters keep the
  // not-found / not-a-proposal branches clean. Customer-safe columns only.
  const { data: est } = await supabase
    .from("estimates")
    .select(
      "id, organization_id, job_id, customer_id, title, status, requires_signature, estimate_number, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, exclusions, terms, payment_schedule, show_itemized, proposal_intro, proposal_accent, jobs(name, address, type), customers(name, address)"
    )
    .eq("id", id)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!est) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }
  if (!est.requires_signature || est.status !== "sent") {
    return NextResponse.json(
      { error: "This proposal is not awaiting your signature." },
      { status: 400 }
    );
  }

  const orgId = est.organization_id as string | null;
  if (!orgId) {
    return NextResponse.json({ error: "Proposal has no organization" }, { status: 500 });
  }

  const jobRow = est.jobs as unknown as
    | { name: string; address: string | null; type: string | null }
    | null;
  const custRow = est.customers as unknown as
    | { name: string; address: string | null }
    | null;
  const jobType = jobRow?.type ?? "construction";
  const customerName = custRow?.name ?? "—";
  const jobName =
    jobRow?.name ?? (est.title as string | null) ?? customerName;
  const projectAddress = jobRow?.address ?? custRow?.address ?? null;

  const pricing: EstimatePricing = {
    markupPct: Number(est.markup_pct) || 0,
    contingencyPct: Number(est.contingency_pct) || 0,
    taxPct: Number(est.tax_pct) || 0,
    depositPct: Number(est.deposit_pct) || 0,
    depositAmount: Number(est.deposit_amount) || 0,
  };

  // Customer-safe line items (no cost_code_id, no internal_cost) — needed for
  // both the PDF and the invoice snapshot.
  const { data: lineItems } = await supabase
    .from("estimate_line_items")
    .select("id, description, quantity, unit_price, position, section")
    .eq("estimate_id", id)
    .order("position");
  const items = (lineItems ?? []).map((i) => ({
    id: i.id,
    description: i.description ?? "",
    quantity: Number(i.quantity) || 0,
    unitPrice: Number(i.unit_price) || 0,
    section: i.section ?? null,
    position: Number(i.position) || 0,
  }));

  // Org branding for the PDF header + the office notification email.
  const { data: o } = await supabase
    .from("organizations")
    .select("name, address, phone, email, logo_path")
    .eq("id", orgId)
    .maybeSingle();
  const orgName = (o?.name as string | null) ?? "";
  const orgAddress = (o?.address as string | null) ?? null;
  const orgPhone = (o?.phone as string | null) ?? null;
  const orgEmail = (o?.email as string | null) ?? null;

  // ── 3. Upload the drawn signature PNG (service role) ──────────────────────
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const sigPath = `${orgId}/${id}/signature-${Date.now()}.png`;
  // The data URL body after the prefix is the base64 payload.
  const sigBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const sigBytes = Buffer.from(sigBase64, "base64");
  const { error: sigUploadError } = await admin.storage
    .from("proposal-docs")
    .upload(sigPath, sigBytes, { contentType: "image/png", upsert: false });
  if (sigUploadError) {
    return NextResponse.json(
      { error: `Failed to store signature: ${sigUploadError.message}` },
      { status: 500 }
    );
  }
  // Rollback the signature object if anything after this point fails before
  // the portal_approvals row is linked (the receipts/share rollback idiom).
  const rollbackSignature = async () => {
    try {
      await admin.storage.from("proposal-docs").remove([sigPath]);
    } catch {
      // best-effort
    }
  };

  // ── 4. sign_proposal RPC (atomic signature record + status flip) ──────────
  const ip = signerIp(request);
  const { data: approvalId, error: rpcError } = await admin.rpc(
    "sign_proposal",
    {
      p_estimate_id: id,
      p_signature_text: signatureText,
      p_signature_image_path: sigPath,
      p_signer_name: signerName,
      p_signer_ip: ip,
    }
  );
  if (rpcError || !approvalId) {
    await rollbackSignature();
    const msg = rpcError?.message ?? "Sign failed";
    const forbidden = /Only customer accounts|Not authorized|not awaiting action/i.test(
      msg
    );
    return NextResponse.json(
      { error: msg },
      { status: forbidden ? 403 : 500 }
    );
  }

  // From here the signature is legally recorded (portal_approvals row exists +
  // estimate is 'approved'). The PDF + invoice are downstream artifacts — their
  // failure must never undo the signature, only surface a warning to the office.

  // ── 5. Generate the signed PDF (jspdf) ────────────────────────────────────
  const totals = computeEstimateTotals(
    items.map((i) => ({ quantity: i.quantity, unit_price: i.unitPrice })),
    pricing
  );
  const hasPricing =
    totals.markupAmount > 0 ||
    totals.contingencyAmount > 0 ||
    totals.taxAmount > 0 ||
    totals.depositAmount > 0;
  const grandTotal = hasPricing ? totals.grandTotal : totals.subtotal;
  const signedAt = new Date();
  const accentRaw = ((est.proposal_accent as string | null) ?? "").trim();
  const accent = /^#[0-9a-fA-F]{6}$/.test(accentRaw) ? accentRaw : "#1e293b";
  const accentRgb = hexToRgb(accent);
  const intro = (est.proposal_intro as string | null)?.trim() || null;

  let pdfPath: string | null = null;
  try {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 40;
    let y = 0;

    // Header band.
    doc.setFillColor(accentRgb[0], accentRgb[1], accentRgb[2]);
    doc.rect(0, 0, pageW, 64, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(orgName || "Proposal", margin, 30);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("PROPOSAL", margin, 46);
    if (est.estimate_number) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(`#${est.estimate_number}`, pageW - margin, 30, {
        align: "right",
      });
    }
    y = 64 + 24;

    // Org contact line.
    doc.setTextColor(107, 114, 128);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const contactBits = [orgAddress, orgPhone, orgEmail].filter(Boolean);
    if (contactBits.length > 0) {
      doc.text(contactBits.join("   ·   "), margin, y);
      y += 14;
    }

    // Prepared for / project.
    doc.setTextColor(17, 24, 39);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Prepared for:", margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(customerName, margin + 80, y);
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.text("Project:", margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(jobName, margin + 80, y);
    y += 16;
    if (projectAddress) {
      doc.setFont("helvetica", "bold");
      doc.text("Location:", margin, y);
      doc.setFont("helvetica", "normal");
      doc.text(projectAddress, margin + 80, y);
      y += 16;
    }
    doc.setTextColor(107, 114, 128);
    doc.setFontSize(8);
    doc.text(`Sent ${signedAt.toLocaleDateString()}`, margin, y);
    y += 6;

    // Intro letter.
    if (intro) {
      y += 14;
      doc.setTextColor(31, 41, 55);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      const introLines = doc.splitTextToSize(intro, pageW - margin * 2);
      doc.text(introLines, margin, y);
      y += introLines.length * 12 + 8;
    }

    // Line items table.
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    doc.text("SCOPE OF WORK", margin, y);
    y += 10;
    doc.setDrawColor(229, 231, 235);
    doc.line(margin, y, pageW - margin, y);
    y += 6;

    // Column geometry.
    const colDescX = margin;
    const colQtyX = pageW - margin - 220;
    const colPriceX = pageW - margin - 140;
    const colAmtX = pageW - margin;
    doc.setFontSize(8);
    doc.setTextColor(107, 114, 128);
    doc.setFont("helvetica", "bold");
    doc.text("Description", colDescX, y);
    doc.text("Qty", colQtyX, y, { align: "right" });
    doc.text("Unit Price", colPriceX, y, { align: "right" });
    doc.text("Amount", colAmtX, y, { align: "right" });
    y += 10;

    let currentSection: string | null = null;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(17, 24, 39);
    for (const item of items) {
      const section = item.section?.trim() || null;
      if (section && section !== currentSection) {
        currentSection = section;
        y += 4;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(31, 41, 55);
        doc.text(section.toUpperCase(), colDescX, y);
        y += 11;
        doc.setFont("helvetica", "normal");
        doc.setTextColor(17, 24, 39);
      }
      if (y > doc.internal.pageSize.getHeight() - 60) {
        doc.addPage();
        y = margin;
      }
      doc.setFontSize(9);
      const descLines = doc.splitTextToSize(
        item.description || "—",
        colQtyX - colDescX - 8
      );
      doc.text(descLines, colDescX, y);
      doc.text(String(item.quantity), colQtyX, y, { align: "right" });
      doc.text(formatMoney(item.unitPrice), colPriceX, y, { align: "right" });
      doc.text(
        formatMoney(item.quantity * item.unitPrice),
        colAmtX,
        y,
        { align: "right" }
      );
      y += descLines.length * 11 + 2;
    }

    // Pricing summary (right-aligned block).
    y += 8;
    doc.setDrawColor(229, 231, 235);
    doc.line(margin, y, pageW - margin, y);
    y += 14;
    const sumX = pageW - margin - 160;
    const valX = pageW - margin;
    const sumRow = (label: string, value: string, bold = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setTextColor(bold ? 17 : 107, bold ? 24 : 114, bold ? 39 : 128);
      doc.setFontSize(bold ? 11 : 9);
      doc.text(label, sumX, y);
      doc.text(value, valX, y, { align: "right" });
      y += bold ? 16 : 13;
    };
    sumRow("Subtotal", formatMoney(totals.subtotal));
    if (totals.markupAmount > 0)
      sumRow(`Overhead & Profit (${pricing.markupPct}%)`, formatMoney(totals.markupAmount));
    if (totals.contingencyAmount > 0)
      sumRow(`Contingency (${pricing.contingencyPct}%)`, formatMoney(totals.contingencyAmount));
    if (totals.taxAmount > 0)
      sumRow(`Sales Tax (${pricing.taxPct}%)`, formatMoney(totals.taxAmount));
    sumRow("Grand Total", formatMoney(grandTotal), true);
    if (totals.depositAmount > 0) {
      sumRow("Deposit Due", formatMoney(totals.depositAmount));
      sumRow("Balance Due", formatMoney(totals.balanceDue));
    }

    // Terms / exclusions / payment schedule.
    const textBlock = (heading: string, body: string) => {
      if (!body.trim()) return;
      if (y > doc.internal.pageSize.getHeight() - 80) {
        doc.addPage();
        y = margin;
      }
      y += 14;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(107, 114, 128);
      doc.text(heading.toUpperCase(), margin, y);
      y += 12;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(31, 41, 55);
      const lines = doc.splitTextToSize(body, pageW - margin * 2);
      doc.text(lines, margin, y);
      y += lines.length * 11 + 6;
    };
    textBlock("Exclusions", (est.exclusions as string | null) ?? "");
    textBlock("Terms & Conditions", (est.terms as string | null) ?? "");
    textBlock("Payment Schedule", (est.payment_schedule as string | null) ?? "");

    // Signature block.
    if (y > doc.internal.pageSize.getHeight() - 150) {
      doc.addPage();
      y = margin;
    }
    y += 24;
    doc.setDrawColor(17, 24, 39);
    doc.line(margin, y, margin + 240, y);
    // Embed the drawn signature sitting on the signature line.
    const box = fitBox(sigW, sigH, 220, 50);
    try {
      doc.addImage(
        dataUrl,
        "PNG",
        margin + 10,
        y - box.h - 2,
        box.w,
        box.h
      );
    } catch {
      // If the image can't be embedded (malformed data URL slipped past the
      // regex), the typed name below still stands as the signature of record.
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(17, 24, 39);
    doc.text(signerName, margin, y + 12);
    doc.setTextColor(107, 114, 128);
    doc.setFontSize(7);
    doc.text(
      `Signed electronically on ${signedAt.toLocaleString()}${
        ip ? ` · IP ${ip}` : ""
      }`,
      margin,
      y + 22
    );

    const pdfBytes = doc.output("arraybuffer") as ArrayBuffer;
    pdfPath = `${orgId}/${id}/signed-proposal-${Date.now()}.pdf`;
    const { error: pdfUploadError } = await admin.storage
      .from("proposal-docs")
      .upload(pdfPath, Buffer.from(pdfBytes), {
        contentType: "application/pdf",
        upsert: false,
      });
    if (pdfUploadError) {
      // Non-fatal: the signature is recorded; the office just won't have the
      // PDF artifact. Log via a notification below.
      pdfPath = null;
    }
  } catch {
    // jspdf failures must not undo the signature. Continue without a PDF.
    pdfPath = null;
  }

  // ── 6. Link the signed PDF on portal_approvals + estimates ────────────────
  if (pdfPath) {
    await admin
      .from("portal_approvals")
      .update({ signed_pdf_path: pdfPath })
      .eq("id", approvalId);
    await admin
      .from("estimates")
      .update({ signed_proposal_url: pdfPath })
      .eq("id", id);
  }

  // ── 7. Create the invoice (construction only) + deliver + notify ──────────
  let invoiceId: string | null = null;
  let invoiceWarning: string | null = null;
  if (jobType === "construction") {
    // Guard against an existing invoice (defensive — the RPC status guard
    // already prevents a true double-sign, but a re-open edge shouldn't dup).
    const { data: existingInv } = await admin
      .from("invoices")
      .select("id")
      .eq("estimate_id", id)
      .maybeSingle();
    if (existingInv) {
      invoiceId = existingInv.id as string;
    } else {
      const invResult = await createInvoiceFromEstimate(admin, {
        estimateId: id,
        jobId: est.job_id as string | null,
        customerId: est.customer_id as string | null,
        markupPct: Number(pricing.markupPct) || 0,
        contingencyPct: Number(pricing.contingencyPct) || 0,
        taxPct: Number(pricing.taxPct) || 0,
        depositPct: Number(pricing.depositPct) || 0,
        depositAmount: Number(pricing.depositAmount) || 0,
        items: items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          unit_price: i.unitPrice,
          position: i.position,
        })),
      });
      if ("error" in invResult && invResult.error) {
        invoiceWarning = invResult.error;
      } else if ("invoiceId" in invResult) {
        invoiceId = invResult.invoiceId ?? null;
      }
    }
  }

  const origin = requestOrigin(request);

  // Deliver the invoice (best-effort) — only if we created/found one.
  if (invoiceId) {
    try {
      await deliverInvoice(invoiceId, { origin });
    } catch {
      // Non-fatal; the invoice exists and is re-sendable from the invoice page.
    }
  }

  // Notify the office — email (best-effort) + in-app feed (deduped).
  const estimateOfficeUrl = `${origin}/estimates/${id}`;
  if (orgEmail) {
    try {
      await sendEstimateDecisionEmail({
        to: orgEmail,
        orgName: orgName || "your contractor",
        customerName,
        jobName,
        estimateNumber: (est.estimate_number as string | null) ?? null,
        decision: "approved",
        estimateUrl: estimateOfficeUrl,
      });
    } catch {
      // best-effort
    }
  }
  // The 'Proposal signed' office notification is inserted by the sign_proposal
  // RPC itself (deduped on (type, entity_id)); no need to re-insert here. Only
  // surface a DISTINCT notice when the invoice failed to create, so the office
  // can create it manually rather than the gap going silent.
  if (invoiceWarning) {
    try {
      await admin.from("notifications").insert({
        organization_id: orgId,
        type: "estimate_approved",
        title: "Invoice creation failed for signed proposal",
        body: `${customerName} · ${jobName} — ${invoiceWarning}. Create the invoice manually.`,
        href: `/estimates/${id}`,
        entity_id: id,
      });
    } catch {
      // best-effort
    }
  }

  return NextResponse.json({
    ok: true,
    invoiceId,
    signedPdfPath: pdfPath,
  });
}