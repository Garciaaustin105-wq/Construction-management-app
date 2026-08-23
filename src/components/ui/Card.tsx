import type { ReactNode } from "react";

// Shared card. The `bg-white rounded-lg p-4 shadow-sm` idiom is the most
// repeated markup in the app (~hundreds of sites). This collapses it and gives
// the shared surface/border tokens a home so a future rebrand is centralized.
// Optional header/title slots for the common "titled card" shape.

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
        "bg-surface rounded-lg border border-line shadow-sm p-4" +
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
        <h3 className="text-sm font-semibold text-gray-900 truncate">{title}</h3>
        {subtitle && <p className="text-xs text-muted truncate">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}