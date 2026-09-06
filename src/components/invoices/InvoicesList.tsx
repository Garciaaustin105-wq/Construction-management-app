"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { formatMoney } from "@/lib/money";
import StatusBadge, { type BadgeTone } from "@/components/ui/StatusBadge";
import DataTable, { type Column } from "@/components/ui/DataTable";
import SortHeader from "@/components/ui/SortHeader";

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

type SortKey = "customerName" | "jobName" | "status" | "total" | "date";
type SortDir = "asc" | "desc";

// Client-side search + sort over an already-fetched (server-filtered by
// status) row set — the list is bounded per org, so filtering in the browser
// avoids a round-trip per keystroke. Desktop gets sortable column headers;
// mobile cards use the same filtered/sorted order so the two views never
// disagree about what's visible.
//
// Desktop UI pass, phase 2: both views render from the shared DataTable —
// the desktop grid-table became a real <table> (shared idiom + density
// tokens), the mobile card JSX moved verbatim into mobileCard (wrapper
// padding kept at the page's p-4 via mobileCardClassName).
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

  const columns: Column<InvoiceRow>[] = [
    {
      key: "customerName",
      header: (
        <SortHeader col="customerName" label="Customer" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
      ),
      cell: (inv) => <span className="min-w-0 truncate font-medium text-gray-900">{inv.customerName}</span>,
    },
    {
      key: "jobName",
      header: (
        <SortHeader col="jobName" label="Job" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
      ),
      cell: (inv) => <span className="min-w-0 truncate text-sm text-gray-500">{inv.jobName}</span>,
      hideOnMobile: true,
    },
    {
      key: "status",
      header: (
        <SortHeader col="status" label="Status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
      ),
      cell: (inv) => (
        <StatusBadge tone={STATUS_TONE[inv.status] ?? "neutral"}>
          {STATUS_LABEL[inv.status] ?? inv.status}
        </StatusBadge>
      ),
    },
    {
      key: "total",
      header: (
        <SortHeader col="total" label="Total" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
      ),
      align: "right",
      num: true,
      cell: (inv) => <span className="text-sm font-semibold text-gray-900">{formatMoney(inv.total)}</span>,
      hideOnMobile: true,
    },
    {
      key: "date",
      header: (
        <SortHeader col="date" label="Date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
      ),
      cell: (inv) => <span className="text-sm text-gray-500">{dateFor(inv)}</span>,
      hideOnMobile: true,
    },
  ];

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
        <DataTable
          columns={columns}
          rows={filtered}
          rowHref={(inv) => `/invoices/${inv.id}`}
          framed
          mobileCardClassName="p-4"
          mobileCard={(inv) => (
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
          )}
        />
      )}
    </div>
  );
}