// Presentational KPI tile for the /lawn/insights owner dashboard. Reuses the
// app's card pattern (bg-white rounded-lg p-3 shadow-sm) seen in the weekly
// report totals strip. Stateless — just props → markup. The optional `icon`
// is a lucide element the caller supplies (keeps this component icon-free).
//
// No "use client" — pure SVG/markup renders fine in a server component, and
// keeping it server-safe lets the insights page (server component) import it
// without crossing the client boundary.

import type { LucideIcon } from "lucide-react";

type Props = {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  tone?: "default" | "green" | "amber" | "blue" | "red";
};

const TONE: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-gray-900",
  green: "text-green-700",
  amber: "text-amber-700",
  blue: "text-blue-700",
  red: "text-red-700",
};

export default function KpiTile({ label, value, sub, icon: Icon, tone = "default" }: Props) {
  return (
    <div className="bg-white rounded-lg p-3 shadow-sm flex items-start gap-2.5">
      {Icon && (
        <span className={`mt-0.5 ${TONE[tone]}`}>
          <Icon className="w-5 h-5" />
        </span>
      )}
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold leading-tight">
          {label}
        </p>
        <p className={`text-lg font-bold leading-tight ${TONE[tone]}`}>{value}</p>
        {sub && <p className="text-[11px] text-gray-400 leading-tight">{sub}</p>}
      </div>
    </div>
  );
}