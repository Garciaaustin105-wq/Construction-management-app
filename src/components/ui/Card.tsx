import type { ReactNode } from "react";

import { isLawn } from "@/lib/variant";

// Shared card. The `bg-white rounded-lg p-4 shadow-sm` idiom is the most
// repeated markup in the app (~hundreds of sites). This collapses it and gives
// the shared surface/border tokens a home so a future rebrand is centralized.
// Optional header/title slots for the common "titled card" shape.
//
// Variant split: the class strings below are computed once at module scope
// from isLawn(), so the construction build renders byte-identical markup to
// before while the lawn (Terra Verde) build gets its own treatment. Note the
// lawn card deliberately has NO shadow: in the redesign shadow is reserved
// for elements that actually float, not for every block on the page.

const CARD_CLASS = isLawn()
  ? "bg-surface rounded-[14px] border border-line-soft p-[18px]"
  : "bg-surface rounded-lg border border-line shadow-sm p-4";

const HEADER_TITLE_CLASS = isLawn()
  ? "font-display text-[16px] font-semibold text-foreground truncate tracking-[-0.01em]"
  : "text-sm font-semibold text-gray-900 truncate";

// Subtitle styling is identical in both variants; kept as a named constant so
// every header class goes through the same mechanism.
const HEADER_SUBTITLE_CLASS = "text-xs text-muted truncate";

export default function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag
      className={
        CARD_CLASS +
        (className ? ` ${className}` : "")
      }
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "flex items-start justify-between gap-3 mb-3" +
        (className ? ` ${className}` : "")
      }
    >
      <div className="min-w-0">
        <h3 className={HEADER_TITLE_CLASS}>{title}</h3>
        {subtitle && <p className={HEADER_SUBTITLE_CLASS}>{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}