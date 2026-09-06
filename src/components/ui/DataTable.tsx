import Link from "next/link";
import { Fragment, type ReactNode } from "react";

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
//
// Desktop UI pass, phase 1: row metrics come from the density tokens in
// globals.css (`--row-py` / `--row-fs`), so the STANDARD/COMPACT toggle
// (DensityToggle) reaches every table at once with no per-page wiring.
// `density="compact"` forces the compact metrics on one table regardless of
// the user's global setting (element declaration beats inherited :root).
// Money/count columns set `align: "right"` + `num` for tabular numerals.

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  // Tabular numerals — pair with align: "right" for money/count columns.
  num?: boolean;
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
  density,
  framed,
  mobileCardClassName,
  mobileCardBare,
  mobileListClassName,
  rowExpansion,
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
  // Omit (default) to follow the user's global density setting; "compact"
  // forces this one table compact regardless of that setting.
  density?: "standard" | "compact";
  // Card chrome around the desktop table (rounded border + shadow) — the
  // shell the hand-rolled tables carried; list views inside a plain page
  // content column usually want it.
  framed?: boolean;
  // Padding class for the mobile card wrapper. Default "p-3"; a page whose
  // pre-migration cards used different padding passes its own value here so
  // the mobile output stays pixel-identical across the migration. A function
  // form receives the row — for cards whose wrapper classes vary per row
  // (e.g. dimmed inactive rows).
  mobileCardClassName?: string | ((row: T) => string);
  // Drop the standard card chrome (surface / border / shadow) from the mobile
  // card wrapper, for pages whose pre-migration cards carried their own shell
  // (selectable rows with an action bar, say). `mobileCardClassName` then
  // supplies the FULL wrapper classes.
  mobileCardBare?: boolean;
  // Replaces the mobile list wrapper's classes (default `lg:hidden space-y-2`).
  // For pages whose pre-migration mobile list was a single divided container
  // rather than separate spaced cards.
  mobileListClassName?: string;
  // Full-width expansion under a desktop row (inline edit forms, accordions):
  // returning a node renders an extra <tr> with one colSpan cell directly
  // below that row; null renders nothing. Mobile cards handle their own
  // expansion inside `mobileCard`.
  rowExpansion?: (row: T) => ReactNode | null;
}) {
  if (rows.length === 0) return <>{emptyState ?? null}</>;

  const mobileCols = columns.filter((c) => !c.hideOnMobile);
  const titleCol = mobileCols[0];
  const metaCol = mobileCols[1];
  const padFor = (row: T) => {
    const custom =
      typeof mobileCardClassName === "function" ? mobileCardClassName(row) : mobileCardClassName;
    return mobileCardBare
      ? custom ?? ""
      : `bg-surface rounded-lg border border-line shadow-sm ${custom ?? "p-3"}`;
  };

  return (
    <div className={density === "compact" ? "dt-force-compact" : undefined}>
      {/* Desktop table */}
      <div
        className={
          framed
            ? "hidden lg:block rounded-lg border border-line shadow-sm overflow-hidden"
            : "hidden lg:block"
        }
      >
        <table className="w-full">
          <thead>
            <tr
              className={`text-xs uppercase tracking-wide text-muted border-b border-line ${
                framed ? "bg-gray-50" : ""
              }`}
            >
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
          <tbody className="text-[length:var(--row-fs)]">
            {rows.map((row, i) => {
              const href = rowHref ? rowHref(row) : undefined;
              const expansion = rowExpansion ? rowExpansion(row) : null;
              return (
                <Fragment key={i}>
                  <tr className="relative hover:bg-surface-muted">
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-[var(--row-py)] border-b border-line/60 ${ALIGN[c.align ?? "left"]} ${c.num ? "tabular-nums" : ""} relative z-10 ${c.className ?? ""}`}
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
                  {expansion && (
                    <tr>
                      <td colSpan={columns.length} className="p-3 border-b border-line/60">
                        {expansion}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className={mobileListClassName ?? "lg:hidden space-y-2"}>
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

          // A bare card owns its own chrome AND its own navigation (its
          // content typically carries a real <Link> of its own), so DataTable
          // never wraps it in one — nested anchors are invalid HTML.
          if (href && !mobileCardBare) {
            return (
              <Link
                key={i}
                href={href}
                className={`block ${padFor(row)} active:bg-gray-50`}
              >
                {inner}
              </Link>
            );
          }
          return (
            <div
              key={i}
              className={padFor(row)}
            >
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}