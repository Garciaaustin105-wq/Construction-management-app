"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

export type ExportRow = {
  person: string;
  job: string;
  costCode: string;
  clockIn: string;
  clockOut: string;
  hours: string;
  note: string;
};

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export default function TimeExportButton({ rows }: { rows: ExportRow[] }) {
  const [busy, setBusy] = useState(false);

  function onExport() {
    if (rows.length === 0) return;
    setBusy(true);
    try {
      const header = ["Person", "Job", "Cost Code", "Clock In", "Clock Out", "Hours", "Note"];
      const lines = rows.map((r) =>
        [r.person, r.job, r.costCode, r.clockIn, r.clockOut, r.hours, r.note]
          .map(csvEscape)
          .join(",")
      );
      const csv = [header.join(","), ...lines].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `time-${new Date().toISOString().slice(0, 10)}.csv`;
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
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
      Export Shifts CSV ({rows.length})
    </button>
  );
}