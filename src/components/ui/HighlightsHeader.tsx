import type { ReactNode } from "react";
import StatusBadge, { type BadgeTone } from "./StatusBadge";

// Pinned record-header panel — the Salesforce "highlights panel" that sits
// at the top of a detail page: an accent bar, the record title + subtitle, a
// status badge, a row of key fields (customer / total / date / assignee), and
// the primary actions. Replaces the hand-rolled status+meta+buttons block
// at the top of job/estimate/invoice/proposal detail pages.
//
// Server component. `status` and `fields` are optional so a page uses only
// what it has. Actions are a slot (caller composes <LinkButton>/<Button>) so
// the header stays free of data-fetching / onClick wiring.
//
// "A bit of both": borrows the Salesforce highlights *structure* (pinned,
// dense, status-forward) but keeps our card language (bg-surface, border-line,
// shadow-sm) and blue primary actions — not a Salesforce skin.

export default function HighlightsHeader({
  title,
  subtitle,
  status,
  fields = [],
  actions,
  accent = "brand",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: { label: ReactNode; tone?: BadgeTone };
  // Key fields shown in a responsive grid below the title row. Keep to ~4;
  // they wrap on narrow desktops and go 2-col on mobile.
  fields?: { label: ReactNode; value: ReactNode }[];
  actions?: ReactNode;
  // Tints the top accent bar. Defaults to brand (blue); use success/warning/
  // danger to mirror the record's status when it maps cleanly.
  accent?: BadgeTone;
}) {
  const ACCENT_BAR: Record<BadgeTone, string> = {
    neutral: "bg-gray-400",
    brand: "bg-brand",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    muted: "bg-gray-300",
  };

  return (
    <div className="bg-surface rounded-lg border border-line shadow-sm overflow-hidden">
      <div className={`h-1 ${ACCENT_BAR[accent]}`} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-gray-900 truncate">{title}</h1>
              {status && <StatusBadge tone={status.tone ?? "neutral"} size="md">{status.label}</StatusBadge>}
            </div>
            {subtitle && <p className="text-sm text-muted truncate mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-col items-end gap-2 flex-shrink-0">{actions}</div>}
        </div>

        {fields.length > 0 && (
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-3 mt-4 pt-4 border-t border-line">
            {fields.map((f, i) => (
              <div key={i} className="min-w-0">
                <dt className="text-[11px] font-medium text-muted uppercase tracking-wide truncate">
                  {f.label}
                </dt>
                <dd className="text-sm font-semibold text-gray-900 truncate mt-0.5">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}