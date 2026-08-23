import type { ReactNode } from "react";

// Shared status pill. Collapses the `text-[10px] font-medium px-1.5 py-0.5
// rounded bg-gray-100 text-gray-600` idiom that's duplicated across the
// estimate/invoice/job/daily-log list + detail pages, each with its own
// hand-rolled statusColor map.
//
// Domain-agnostic: callers pass a `tone` (not a raw color), and own the
// status→tone mapping for their domain (estimate statuses ≠ invoice statuses
// ≠ job statuses, so centralizing the map would couple unrelated features).
// `tone` picks from semantic tokens + the standard Tailwind 50-shade tints so
// the palette stays consistent without a per-status color table here.

export type BadgeTone =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "muted";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-700",
  brand: "bg-brand-bg text-brand-dark",
  success: "bg-green-50 text-success",
  warning: "bg-amber-50 text-warning",
  danger: "bg-red-50 text-danger",
  muted: "bg-gray-50 text-muted",
};

const SIZES = {
  sm: "text-[10px] px-1.5 py-0.5",
  md: "text-xs px-2 py-1",
} as const;

export default function StatusBadge({
  tone = "neutral",
  size = "sm",
  children,
  className,
}: {
  tone?: BadgeTone;
  size?: "sm" | "md";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center font-medium rounded ${TONES[tone]} ${SIZES[size]}${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </span>
  );
}