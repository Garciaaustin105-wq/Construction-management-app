// Presentational KPI tile for the /lawn/insights owner dashboard. Reuses the
// app's card pattern seen in the weekly report totals strip — bg-white
// rounded-lg p-3 shadow-sm in the construction build, a bordered surface card
// with a tone-coloured top accent bar in the lawn build. Stateless — just
// props → markup. The optional `icon` is a lucide element the caller supplies
// (keeps this component icon-free).
//
// Variant split: this codebase builds two apps from one codebase, switched by
// the build-time constant isLawn() (true only in the lawn build). All class
// strings are resolved once at module scope via ternaries on isLawn(); the
// else branches keep the construction strings verbatim (including the
// original TONE map), and the lawn branches use the per-variant tokens plus
// the accent bar. The accent bar <span> is gated on isLawn() so the
// construction build never renders it.
//
// No "use client" — pure SVG/markup renders fine in a server component, and
// keeping it server-safe lets the insights page (server component) import it
// without crossing the client boundary.

import type { LucideIcon } from "lucide-react";

import { isLawn } from "@/lib/variant";

type Props = {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  tone?: "default" | "green" | "amber" | "blue" | "red";
};

// Construction tone colours — kept verbatim; the construction build must
// render exactly these classes.
const TONE: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-gray-900",
  green: "text-green-700",
  amber: "text-amber-700",
  blue: "text-blue-700",
  red: "text-red-700",
};

// Lawn tone colours (per-variant tokens) for the value text and icon.
const TONE_LAWN: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-foreground",
  green: "text-success",
  amber: "text-caution",
  blue: "text-water",
  red: "text-danger",
};

// Lawn-only accent-bar background per tone — how a tile's meaning is read
// before its label.
const ACCENT: Record<NonNullable<Props["tone"]>, string> = {
  default: "bg-brand",
  green: "bg-success",
  amber: "bg-caution",
  blue: "bg-water",
  red: "bg-danger",
};

// Class strings resolved once at module scope; construction branch verbatim.
const WRAPPER = isLawn()
  ? "relative overflow-hidden bg-surface rounded-[14px] border border-line-soft px-[15px] py-[14px] flex items-start gap-2.5"
  : "bg-white rounded-lg p-3 shadow-sm flex items-start gap-2.5";

const LABEL = isLawn()
  ? "text-[10.5px] uppercase tracking-[0.06em] text-muted font-bold leading-tight"
  : "text-[11px] uppercase tracking-wide text-gray-400 font-semibold leading-tight";

const VALUE = isLawn()
  ? "font-num text-[23px] font-semibold leading-tight tabular-nums"
  : "text-lg font-bold leading-tight";

const SUB = isLawn()
  ? "text-[11px] text-muted leading-tight"
  : "text-[11px] text-gray-400 leading-tight";

const TONE_MAP = isLawn() ? TONE_LAWN : TONE;

export default function KpiTile({ label, value, sub, icon: Icon, tone = "default" }: Props) {
  return (
    <div className={WRAPPER}>
      {isLawn() && (
        <span aria-hidden className={"absolute top-0 left-0 right-0 h-[3px] " + ACCENT[tone]} />
      )}
      {Icon && (
        <span className={`mt-0.5 ${TONE_MAP[tone]}`}>
          <Icon className="w-5 h-5" />
        </span>
      )}
      <div className="min-w-0">
        <p className={LABEL}>{label}</p>
        <p className={`${VALUE} ${TONE_MAP[tone]}`}>{value}</p>
        {sub && <p className={SUB}>{sub}</p>}
      </div>
    </div>
  );
}