import type { ReactNode } from "react";

// Shared section overline — promoted from the local helper in
// src/app/dashboard/page.tsx. One understated style for the "Create / Manage /
// Track" group labels so they read as dividers, not competing headings.
// (The job-detail/invoice pages used a competing `text-sm font-semibold
// text-gray-500 uppercase mb-2`; migrating to this as pages are touched.)

export default function SectionHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={
        "text-xs font-bold text-gray-400 uppercase tracking-wide" +
        (className ? ` ${className}` : "")
      }
    >
      {children}
    </h2>
  );
}