"use client";
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export default function PunchExportButton({ rows }: { rows: { title: string; job: string; location: string; assignee: string; status: string; priority: string; due: string }[] }) {
  const [busy, setBusy] = useState(false);
  function onExport() {
    if (rows.length === 0) return;
    setBusy(true);
    try {
      const header = ["Title", "Job", "Location", "Assignee", "Status", "Priority", "Due"];
      const lines = rows.map(r => [r.title, r.job, r.location, r.assignee, r.status, r.priority, r.due].map(csvEscape).join(","));
      const csv = [header.join(","), ...lines].join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `punch-list-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } finally {
      setBusy(false);
    }
  }
  return <button onClick={onExport} disabled={busy || rows.length === 0} className="w-full bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export CSV ({rows.length})</button>;
}