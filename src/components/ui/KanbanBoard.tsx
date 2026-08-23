import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import StatusBadge from "./StatusBadge";

// Grouped card lanes — the Salesforce kanban list-view pattern: items grouped
// by status (or any group key) into lanes. Desktop renders lanes side by side
// (horizontal scroll when many); mobile stacks them vertically. Presentational
// only — no drag-and-drop, so callers that need reordering (the leads board)
// layer @dnd-kit on top of their own markup. This is the shared read-only /
// click-through board.
//
// Server component. `itemHref` wraps each card in a <Link>.

export type KanbanLane<T> = {
  key: string;
  title: ReactNode;
  // Tints the lane header count badge. Defaults to neutral.
  tone?: StatusBadgeProps["tone"];
};

type StatusBadgeProps = ComponentProps<typeof StatusBadge>;

export default function KanbanBoard<T>({
  lanes,
  items,
  groupBy,
  card,
  itemHref,
  emptyLane,
}: {
  // Declared in display order; only these keys get a lane (items whose group
  // key isn't listed are dropped — callers should pass a trailing lane like
  // "Other" if they want a catch-all).
  lanes: KanbanLane<T>[];
  items: T[];
  groupBy: (item: T) => string;
  // Compact card body for one item.
  card: (item: T) => ReactNode;
  itemHref?: (item: T) => string;
  // Shown inside an empty lane instead of "No items".
  emptyLane?: ReactNode;
}) {
  const grouped = new Map<string, T[]>();
  for (const lane of lanes) grouped.set(lane.key, []);
  for (const item of items) {
    const k = groupBy(item);
    const bucket = grouped.get(k);
    if (bucket) bucket.push(item);
  }

  return (
    <div className="flex lg:gap-4 lg:overflow-x-auto lg:pb-2 flex-col lg:flex-row">
      {lanes.map((lane) => {
        const bucket = grouped.get(lane.key) ?? [];
        return (
          <div key={lane.key} className="lg:min-w-[18rem] lg:w-[18rem] lg:flex-shrink-0">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-900">{lane.title}</h3>
              <StatusBadge tone={lane.tone ?? "neutral"}>{bucket.length}</StatusBadge>
            </div>
            <div className="space-y-2 bg-surface-muted lg:bg-transparent rounded-lg lg:rounded-none p-2 lg:p-0 min-h-[3rem]">
              {bucket.length === 0 ? (
                <div className="text-xs text-muted text-center py-4">
                  {emptyLane ?? "No items"}
                </div>
              ) : (
                bucket.map((item, i) => {
                  const href = itemHref ? itemHref(item) : undefined;
                  const body = (
                    <div className="bg-surface rounded-lg border border-line shadow-sm p-3">
                      {card(item)}
                    </div>
                  );
                  if (href) {
                    return (
                      <Link key={i} href={href} className="block active:opacity-70">
                        {body}
                      </Link>
                    );
                  }
                  return <div key={i}>{body}</div>;
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}