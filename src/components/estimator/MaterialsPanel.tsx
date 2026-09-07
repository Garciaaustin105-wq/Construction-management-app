"use client";

import { useMemo } from "react";
import { AlertTriangle, PackageSearch } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  buildMaterialTakeoff,
  sodLeftoverSqft,
  takeoffWarning,
  type MaterialLine,
  type TakeoffInput,
} from "@/lib/materialTakeoff";

// What has to be BOUGHT for this estimate — the shopping list, not the quote.
//
// READ-ONLY BY DESIGN. Everything here is derived from what is already on the
// estimate; there is no field to edit, because editing a quantity here would
// silently disagree with the map. Change the estimate and this follows.
//
// Computed from props rather than fetched. The workspace already holds the
// areas and the component rows, so a query here would add a round trip, a
// second RLS surface, and a window where the list disagrees with the screen it
// sits on.

type Props = {
  areas: TakeoffInput["areas"];
  components: TakeoffInput["components"];
};

const UNIT_LABEL: Record<MaterialLine["unit"], string> = {
  each: "ea",
  foot: "ft",
  pallet: "pallet",
};

const SOURCE_LABEL: Record<MaterialLine["source"], string> = {
  plant: "Plants",
  sod: "Sod",
  head: "Heads",
  component: "Parts",
};

export default function MaterialsPanel({ areas, components }: Props) {
  const takeoff = useMemo(
    () => buildMaterialTakeoff({ areas, components }),
    [areas, components]
  );
  const leftover = useMemo(
    () => sodLeftoverSqft({ areas, components }),
    [areas, components]
  );
  const warning = takeoffWarning(takeoff);

  if (takeoff.lines.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-center">
        <PackageSearch className="mx-auto h-5 w-5 text-gray-400" />
        <p className="mt-2 text-xs text-gray-500">
          Nothing to buy yet. Place plants, sod or heads on the map, or add
          parts, and the order list builds itself.
        </p>
      </div>
    );
  }

  // Grouped for reading, but the grouping is presentational only — the contract
  // already returned them in order.
  const groups: { source: MaterialLine["source"]; lines: MaterialLine[] }[] = [];
  for (const line of takeoff.lines) {
    const last = groups[groups.length - 1];
    if (last && last.source === line.source) last.lines.push(line);
    else groups.push({ source: line.source, lines: [line] });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        What this job has to buy, from the quantities already on the estimate.
        Costs are yours, not the customer&apos;s price.
      </p>

      {warning && (
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
          <p className="text-[11px] leading-snug text-amber-900">{warning}</p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.source} className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            {SOURCE_LABEL[g.source]}
          </p>
          {g.lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white p-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-gray-900">{l.label}</p>
                {l.detail && (
                  <p className="text-[11px] text-gray-500">{l.detail}</p>
                )}
                {/* A line that cannot be ordered says so where it is read. */}
                {l.note && (
                  <p className="mt-1 text-[11px] leading-snug text-amber-800">
                    {l.note}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="text-xs font-semibold text-gray-900">
                  {l.orderable ? (
                    <>
                      {l.quantity} {UNIT_LABEL[l.unit]}
                    </>
                  ) : (
                    <span className="text-amber-700">—</span>
                  )}
                </p>
                {/* 0 is not free. An unpriced line says so instead of $0.00. */}
                <p className="text-[11px] text-gray-500">
                  {l.unpriced ? (
                    <span className="text-amber-700">no cost recorded</span>
                  ) : (
                    <>
                      {formatMoney(l.unitCost)}/{UNIT_LABEL[l.unit]} ·{" "}
                      {formatMoney(l.extendedCost)}
                    </>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      ))}

      {/*
        Sod is bought by the pallet, so a job nearly always pays for grass it
        does not lay. It is real money and it is invisible unless it is shown.
      */}
      {leftover > 0 && (
        <p className="text-[11px] text-gray-500">
          Includes {leftover.toLocaleString()} sq ft of sod bought and not laid —
          whole pallets only.
        </p>
      )}

      <div className="flex items-center justify-between border-t border-gray-200 pt-2">
        <span className="text-xs font-semibold text-gray-900">
          Material cost
        </span>
        <span className="text-sm font-semibold text-gray-900 tabular-nums">
          {formatMoney(takeoff.total)}
        </span>
      </div>
      {takeoff.unpricedCount > 0 && (
        <p className="text-[11px] text-amber-800">
          This total excludes {takeoff.unpricedCount} line
          {takeoff.unpricedCount === 1 ? "" : "s"} with no cost recorded. It is
          not the whole bill.
        </p>
      )}
    </div>
  );
}
