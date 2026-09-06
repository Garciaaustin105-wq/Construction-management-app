"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

// Reusable sortable column header for the shared DataTable (desktop UI pass,
// phase 1). DataTable is a server component, so sort state can't live there —
// pages keep the state and drop this into a column's `header` node, same
// shape as the Th these pages hand-roll today (InvoicesList's Th is the
// reference implementation; this is that, token-colored, so phase 2 can
// migrate without inventing a third idiom).
//
// Desktop-only by usage: DataTable renders `header` in the lg: table and
// ignores column headers on mobile (the mobile card fallback uses
// cell content only), so this button never renders on a phone.

export default function SortHeader<K extends string>({
  col,
  label,
  sortKey,
  sortDir,
  onSort,
  align,
}: {
  col: K;
  label: string;
  sortKey: K;
  sortDir: "asc" | "desc";
  onSort: (key: K) => void;
  align?: "right";
}) {
  const on = col === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 uppercase tracking-wide hover:text-muted-strong transition-colors ${
        align === "right" ? "justify-end w-full text-right" : ""
      }`}
    >
      {label}
      {on ? (
        sortDir === "asc" ? (
          <ArrowUp className="w-3 h-3" aria-hidden />
        ) : (
          <ArrowDown className="w-3 h-3" aria-hidden />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}