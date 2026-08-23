"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LayoutGrid, Table as TableIcon, Columns3 } from "lucide-react";

// Salesforce list-view header: a count line + a Cards/Table/Kanban view-mode
// switcher + a filter slot + a primary-action slot. The switcher writes
// `?view=` into the URL (preserving other params like `?status=`) so the
// server page renders the matching primitive and the chosen mode is
// shareable/bookmarkable. Pages render <ListToolbar> above whichever
// primitive the current `?view=` selects.
//
// Client component because the switcher is interactive. Everything else
// (count, filters, action) are slots passed in from the server page.

export type ViewMode = "cards" | "table" | "kanban";

const MODE_META: Record<ViewMode, { label: string; Icon: typeof LayoutGrid }> = {
  cards: { label: "Cards", Icon: LayoutGrid },
  table: { label: "Table", Icon: TableIcon },
  kanban: { label: "Board", Icon: Columns3 },
};

export default function ListToolbar({
  modes = ["cards", "table"],
  defaultMode,
  count,
  filters,
  action,
}: {
  // Which modes the switcher offers, in order. Must include the page's
  // default; the page renders the matching primitive for the active mode.
  modes?: ViewMode[];
  // Used when `?view=` is absent or invalid.
  defaultMode?: ViewMode;
  count?: number;
  // Filter controls slot (selects, date pickers). Laid out below the switcher
  // row on mobile, beside it on desktop.
  filters?: ReactNode;
  // Primary action slot (e.g. <LinkButton href="/x/new">New X</LinkButton>).
  action?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get("view") as ViewMode | null;
  const active: ViewMode =
    raw && (modes as string[]).includes(raw)
      ? raw
      : defaultMode ?? modes[0];

  function setMode(mode: ViewMode) {
    const params = new URLSearchParams(searchParams.toString());
    if (mode === (defaultMode ?? modes[0])) {
      params.delete("view");
    } else {
      params.set("view", mode);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {typeof count === "number" && (
          <p className="text-xs text-muted">
            {count} {count === 1 ? "item" : "items"}
          </p>
        )}
        <div className="flex items-center gap-3">
          {modes.length > 1 && (
            <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
              {modes.map((m) => {
                const { label, Icon } = MODE_META[m];
                const on = m === active;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={on}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      on
                        ? "bg-gray-900 text-white"
                        : "text-muted hover:bg-surface-muted hover:text-gray-900"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                );
              })}
            </div>
          )}
          {action}
        </div>
      </div>
      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
    </div>
  );
}