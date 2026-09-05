"use client";

import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  estimateMargin,
  installTimeUnset,
  mobilizationUnset,
  mobilizationShare,
  laborLineItem,
  type PlantLegendRow,
} from "@/lib/plantProducts";

type Props = {
  rows: PlantLegendRow[];
  laborRate: number | null;
  laborCostRate: number | null;
  mobilizationHours: number | null;
  onChange: (patch: {
    labor_rate?: number | null;
    labor_cost_rate?: number | null;
    mobilization_hours?: number | null;
  }) => void;
  saving: boolean;
  onAddLaborLine: (line: {
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    internal_cost: number;
  }) => void;
  canEdit: boolean;
};

export default function LandscapeLaborPanel({
  rows,
  laborRate,
  laborCostRate,
  mobilizationHours,
  onChange,
  saving,
  onAddLaborLine,
  canEdit,
}: Props) {
  const m = estimateMargin(rows, laborRate, laborCostRate, mobilizationHours);

  // Local state for controlled inputs; keep string to allow empty boxes.
  const [billedRateStr, setBilledRateStr] = useState(
    laborRate === null ? "" : laborRate.toString()
  );
  const [costRateStr, setCostRateStr] = useState(
    laborCostRate === null ? "" : laborCostRate.toString()
  );
  const [mobilizationStr, setMobilizationStr] = useState(
    mobilizationHours === null ? "" : mobilizationHours.toString()
  );

  const parseAndChange = (
    value: string,
    key: "labor_rate" | "labor_cost_rate" | "mobilization_hours"
  ) => {
    const trimmed = value.trim();
    if (trimmed === "") {
      onChange({ [key]: null });
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num < 0) {
      // Invalid input; do not call onChange.
      return;
    }
    onChange({ [key]: num });
  };

  const line = laborLineItem(m.manHours, laborRate, laborCostRate);

  // Render
  return (
    <section className="rounded border border-gray-200/70 bg-white/50 p-2 space-y-2">
      <h2 className="text-xs font-medium text-gray-700">Install labor</h2>

      {rows.length === 0 ? (
        <p className="text-xs text-gray-500">
          Place plants on the map to price install labor.
        </p>
      ) : (
        <>
          {/* Breakdown */}
          <dl className="text-xs text-gray-700">
            <div className="flex items-center gap-1">
              <dt className="font-medium">Material</dt>
              <dd>
                {formatMoney(m.materialRevenue)}{" "}
                <span className="text-gray-500">
                  (cost {formatMoney(m.materialCost)})
                </span>
              </dd>
            </div>

            <div className="flex items-center gap-1">
              <dt className="font-medium">Labor</dt>
              <dd className="text-gray-500">
                {m.plantManHours} planting + {m.mobilizationHours} mobilization
              </dd>
            </div>

            <div className="flex items-center gap-1">
              <dt className="font-medium">Man-hours</dt>
              <dd>
                {m.manHours} man-hours
                {m.laborPriced && (
                  <>
                    {" "}
                    @ {formatMoney(laborRate ?? 0)}
                  </>
                )}
              </dd>
            </div>

            <div className="flex items-center gap-1">
              <dt className="font-medium">Revenue</dt>
              <dd className="font-semibold">{formatMoney(m.laborRevenue)}</dd>
            </div>

            <hr className="my-1 border-gray-300" />

            <div className="flex items-center gap-1">
              <dt className="font-medium">Total</dt>
              <dd className="font-semibold">{formatMoney(m.revenue)}</dd>
            </div>

            <div className="flex items-center gap-1">
              <dt className="font-medium">
                {m.laborPriced
                  ? "Margin (material + labor)"
                  : "Margin (material only)"}
              </dt>
              <dd>
                {m.margin === null
                  ? "—"
                  : `${(m.margin * 100).toFixed(1)}%`}
              </dd>
            </div>
          </dl>

          {/* Inputs */}
          <div className="space-y-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-700">
                Billed rate
              </span>
              <span className="block text-xs text-gray-500">
                per man-hour
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                placeholder="Not set"
                value={billedRateStr}
                onChange={(e) => setBilledRateStr(e.target.value)}
                onBlur={(e) => parseAndChange(e.target.value, "labor_rate")}
                disabled={!canEdit || saving}
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-700">
                Your cost
              </span>
              <span className="block text-xs text-gray-500">
                per man-hour, internal only
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                placeholder="Not set"
                value={costRateStr}
                onChange={(e) => setCostRateStr(e.target.value)}
                onBlur={(e) => parseAndChange(e.target.value, "labor_cost_rate")}
                disabled={!canEdit || saving}
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-700">
                Mobilization
              </span>
              <span className="block text-xs text-gray-500">
                MAN-hours per job: drive, unload, setup, cleanup, haul-off
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                placeholder="Not set"
                value={mobilizationStr}
                onChange={(e) => setMobilizationStr(e.target.value)}
                onBlur={(e) =>
                  parseAndChange(e.target.value, "mobilization_hours")
                }
                disabled={!canEdit || saving}
              />
            </label>
          </div>

          {/* Warnings */}
          <div className="space-y-1">
            {mobilizationUnset(mobilizationHours) && (
              <div className="flex items-start gap-1 text-xs text-amber-700">
                <TriangleAlert className="w-3 h-3 mt-0.5 shrink-0" />
                Mobilization not estimated - small jobs will quote low.
              </div>
            )}
            {installTimeUnset(rows) && (
              <div className="flex items-start gap-1 text-xs text-amber-700">
                <TriangleAlert className="w-3 h-3 mt-0.5 shrink-0" />
                No plant has an install time set - labor is quoting at zero.
              </div>
            )}
            {!m.laborPriced && (
              <div className="flex items-start gap-1 text-xs text-amber-700">
                <TriangleAlert className="w-3 h-3 mt-0.5 shrink-0" />
                No billed rate - the margin above is material only.
              </div>
            )}
            {(mobilizationShare(rows, mobilizationHours) ?? 0) > 0.5 && (
              <div className="flex items-start gap-1 text-xs text-amber-700">
                <TriangleAlert className="w-3 h-3 mt-0.5 shrink-0" />
                Mostly drive time and setup - consider a minimum charge.
              </div>
            )}
          </div>

          {/* Add labor button */}
          <button
            type="button"
            className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            onClick={() => line && onAddLaborLine(line)}
            disabled={!canEdit || line === null}
          >
            {saving ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              "Add labor to estimate"
            )}
          </button>
        </>
      )}
    </section>
  );
}

/* 
 * Why null is not 0: A null value indicates the estimator has not set a
 * value yet, which should render an empty input box. Using 0 would incorrectly
 * display a value and could be misinterpreted as a deliberate setting.
 *
 * Why the button is disabled when line is null: Adding a labor line with
 * zero revenue would create a meaningless entry in the estimate. Disabling
 * the button prevents accidental creation of a $0 line.
 */
