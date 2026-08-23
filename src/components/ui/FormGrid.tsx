import type { ReactNode } from "react";

// Responsive form grid for create/edit forms — the desktop-friendliness
// primitive from the "desktop single-column everywhere" pain. Stacks one
// column on mobile, N columns at `lg`. Fields that should span the full width
// (a long textarea, a wide address block) get `className="lg:col-span-2"` on
// their wrapping element.
//
// Server component (pure layout). Pair with <FormField variant="inline"> for
// the Salesforce-style label-left desktop forms; the default stacked FormField
// is fine for simpler forms.

export default function FormGrid({
  columns = 2,
  className,
  children,
}: {
  // Columns at lg. Mobile is always 1 column (stacked).
  columns?: 1 | 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  const lgCols = { 1: "lg:grid-cols-1", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3" }[columns];
  return (
    <div className={`grid grid-cols-1 ${lgCols} gap-x-6 gap-y-4${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}