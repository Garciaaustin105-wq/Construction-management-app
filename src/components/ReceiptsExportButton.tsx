"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

export type ExportReceipt = {
  id: string;
  jobName: string;
  vendor: string | null;
  amount: number | null;
  capturedAt: string;
  uploader: string | null;
  reimbursed: boolean;
  reimbursedAt: string | null;
  notes: string | null;
};

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsv(rows: ExportReceipt[]): string {
  const header = [
    "Project",
    "Vendor",
    "Amount",
    "Date",
    "Uploader",
    "Paid Back",
    "Paid Back At",
    "Notes",
  ];
  const lines = rows.map((r) =>
    [
      r.jobName,
      r.vendor ?? "",
      r.amount != null ? r.amount.toFixed(2) : "",
      new Date(r.capturedAt).toLocaleDateString(),
      r.uploader ?? "",
      r.reimbursed ? "Yes" : "No",
      r.reimbursedAt ? new Date(r.reimbursedAt).toLocaleDateString() : "",
      r.notes ?? "",
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

export default function ReceiptsExportButton({
  rows,
}: {
  rows: ExportReceipt[];
}) {
  const [busy, setBusy] = useState(false);

  async function onExport() {
    if (rows.length === 0) return;
    setBusy(true);
    try {
      const csv = buildCsv(rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `receipts-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onExport}
      disabled={busy || rows.length === 0}
      className="w-full bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Download className="w-4 h-4" />
      )}
      Export CSV ({rows.length})
    </button>
  );
}