"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { formatMoney } from "@/lib/money";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";

export type InvoiceRow = {
  id: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  jobName: string;
  customerName: string;
  total: number;
};

const STATUS_TONE: { [key: string]: BadgeTone } = {
  sent: "brand",
  paid: "success",
  void: "muted",
  draft: "neutral",
};

const STATUS_LABEL: { [key: string]: string } = {
  sent: "Unpaid",
  paid: "Paid",
  void: "Void",
  draft: "Draft",
};

function dateFor(inv: InvoiceRow): string {
  const d = inv.status === "draft" ? inv.createdAt : inv.paidAt ?? inv.createdAt;
  return new Date(d).toLocaleDateString();
}

// Hoisted out of the list component. Defined inline, these were recreated on
// every render, so React saw a NEW component type each time and remounted the
// header — losing focus and any transient state, and defeating memoisation.
// The closure values they used (sortKey, sortDir, toggleSort) are now props.
function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ArrowUpDown className="w-3 h-3 text-gray-300" />;
  return sortDir === "asc" ? (
    <ArrowUp className="w-3 h-3 text-gray-700" />
  ) : (
    <ArrowDown className="w-3 h-3 text-gray-700" />
  );
}

function Th({
  col,
  label,
  align,
  sortKey,
  sortDir,
  onSort,
}: {
  col: SortKey;
  label: string;
  align?: "right";
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 hover:text-gray-900 transition-colors ${
        align === "right" ? "justify-end text-right" : ""
      }`}
    >
      {label}
      <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
    </button>
  );
}

type SortKey = "customerName" | "jobName" | "status" | "total" | "date";
type SortDir = "asc" | "desc";

const COLS = "grid-cols-[1fr_1fr_120px_120px_130px]";

// Client-side search + sort over an already-fetched (server-filtered by
// status) row set — the list is bounded per org, so filtering in the browser
// avoids a round-trip per keystroke. Desktop gets sortable column headers;
// mobile cards use the same filtered/sorted order so the two views never
// disagree about what's visible.
export default function InvoicesList({ rows }: { rows: InvoiceRow[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? rows.filter(
          (r) =>
            r.customerName.toLowerCase().includes(q) ||
            r.jobName.toLowerCase().includes(q)
        )
      : rows;
    const sorted = [...base].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "customerName":
          cmp = a.customerName.localeCompare(b.customerName);
          break;
        case "jobName":
          cmp = a.jobName.localeCompare(b.jobName);
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "total":
          cmp = a.total - b.total;
          break;
        case "date":
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "total" || key === "date" ? "desc" : "asc");
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative max-w-xs">
        <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search customer or job…"
          className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-6">
          No invoices match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <>
          <div className="space-y-2 lg:hidden">
            {filtered.map((inv) => (
              <Link
                key={inv.id}
                href={`/invoices/${inv.id}`}
                className="block bg-surface rounded-lg border border-line shadow-sm p-4 active:bg-gray-50"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-900 truncate">{inv.customerName}</p>
                    <p className="text-sm text-gray-500 truncate">{inv.jobName}</p>
                    <p className="text-xs text-gray-400 mt-1">{dateFor(inv)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <StatusBadge tone={STATUS_TONE[inv.status] ?? "neutral"}>
                      {STATUS_LABEL[inv.status] ?? inv.status}
                    </StatusBadge>
                    <span className="text-sm font-bold text-gray-900">{formatMoney(inv.total)}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <div className="hidden lg:block rounded-lg border border-line shadow-sm overflow-hidden">
            <div
              className={`grid ${COLS} gap-3 bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-line`}
            >
              <Th col="customerName" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th col="jobName" label="Job" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th col="total" label="Total" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <Th col="date" label="Date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
            </div>
            <div className="divide-y divide-line">
              {filtered.map((inv) => (
                <Link
                  key={inv.id}
                  href={`/invoices/${inv.id}`}
                  className={`grid ${COLS} gap-3 px-4 py-2.5 items-center hover:bg-gray-50 transition-colors`}
                >
                  <span className="min-w-0 truncate font-medium text-gray-900">{inv.customerName}</span>
                  <span className="min-w-0 truncate text-sm text-gray-500">{inv.jobName}</span>
                  <StatusBadge tone={STATUS_TONE[inv.status] ?? "neutral"}>
                    {STATUS_LABEL[inv.status] ?? inv.status}
                  </StatusBadge>
                  <span className="text-right text-sm font-semibold text-gray-900">{formatMoney(inv.total)}</span>
                  <span className="text-sm text-gray-500">{dateFor(inv)}</span>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
