import Link from "next/link";
import type { ReactNode } from "react";

// Desktop dense table + mobile card list from one column config — the
// Salesforce list-view pattern: a real <table> at `lg` (scannable, aligned
// columns), a stacked card list on mobile (a phone can't use a 6-col table).
// Both driven by the same `columns` so a page declares its shape once.
//
// Server component (no state; navigation via next/link). ListToolbar switches
// the surrounding page between cards/table/kanban by writing `?view=`; the
// page renders <DataTable> only when view=table.
//
// Click affordance: `rowHref` wraps each mobile card in a <Link> (full-card
// click), and on the desktop table lays a stretched-link overlay over the row
// so the whole row is clickable while preserving cmd/middle-click. Cell
// content that is itself actionable (a link/button) gets `relative z-10` so
// it sits above the overlay.

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  // Omit from the default mobile card summary (status/amount are often shown
  // separately via `mobileCard`). Ignored when `mobileCard` is provided.
  hideOnMobile?: boolean;
};

const ALIGN: Record<NonNullable<Column<unknown>["align"]>, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

export default function DataTable<T>({
  columns,
  rows,
  rowHref,
  mobileCard,
  emptyState,
}: {
  columns: Column<T>[];
  rows: T[];
  // Makes rows/cards navigable. Omit for non-navigable tables (e.g. a read-only
  // report where cells hold their own links).
  rowHref?: (row: T) => string;
  // Bespoke mobile card. Falls back to a 2-field summary (first non-hidden
  // column as title, second as meta) when omitted.
  mobileCard?: (row: T) => ReactNode;
  emptyState?: ReactNode;
}) {
  if (rows.length === 0) return <>{emptyState ?? null}</>;

  const mobileCols = columns.filter((c) => !c.hideOnMobile);
  const titleCol = mobileCols[0];
  const metaCol = mobileCols[1];

  return (
    <>
      {/* Desktop table */}
      <div className="hidden lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted border-b border-line">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`py-2 px-3 font-medium ${ALIGN[c.align ?? "left"]} ${c.className ?? ""}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const href = rowHref ? rowHref(row) : undefined;
              return (
                <tr key={i} className="relative hover:bg-surface-muted">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`py-2 px-3 border-b border-line/60 ${ALIGN[c.align ?? "left"]} relative z-10 ${c.className ?? ""}`}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {href && (
                    <td className="absolute inset-0 p-0" colSpan={columns.length} aria-hidden>
                      <Link
                        href={href}
                        tabIndex={-1}
                        className="absolute inset-0"
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="lg:hidden space-y-2">
        {rows.map((row, i) => {
          const href = rowHref ? rowHref(row) : undefined;
          const inner = mobileCard ? (
            mobileCard(row)
          ) : (
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 flex-1">
                {titleCol && (
                  <p className="font-semibold text-gray-900 truncate">
                    {titleCol.cell(row)}
                  </p>
                )}
                {metaCol && (
                  <p className="text-xs text-muted truncate">
                    {metaCol.cell(row)}
                  </p>
                )}
              </div>
            </div>
          );

          if (href) {
            return (
              <Link
                key={i}
                href={href}
                className="block bg-surface rounded-lg border border-line shadow-sm p-3 active:bg-gray-50"
              >
                {inner}
              </Link>
            );
          }
          return (
            <div
              key={i}
              className="bg-surface rounded-lg border border-line shadow-sm p-3"
            >
              {inner}
            </div>
          );
        })}
      </div>
    </>
  );
}