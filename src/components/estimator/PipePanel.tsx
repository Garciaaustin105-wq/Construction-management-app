"use client";

// Pipe panel (Lane C). Measurement only — nothing here is billable and nothing
// here persists. pipeEstimate connects the placed heads with the least pipe
// (Prim's MST over straight lines) and this panel adds the two allowances.
//
// TWO allowance fields, not one — they are different quantities and folding
// them together under-buys: routing (20-40%) is how much longer the real
// trench is than the straight line; waste (5-10%) is cut-offs and breakage on
// that longer run. They COMPOUND: 30% and 10% is 1.30 x 1.10 = 1.43, not 1.40.
//
// The straight-line figure is a FLOOR and it excludes the mainline, backflow
// and controller run, because none of those are placed on the map. That
// caveat is carried verbatim below — the number looks exact and it is not.

import { pipeEstimate, type PipeEstimate } from "@/lib/irrigationProducts";
import type { LatLng } from "@/lib/estimateAreas";

// Allowance drafts are CONTROLLED from the workspace, not held here: the Parts
// panel's "Use measured pipe" helper feeds the SAME total to buy, so both
// panels must compute pipeEstimate from one set of strings. Session-local by
// design — there is no column for them and a stale allowance from last month's
// job would be worse than retyping two numbers. Flagged in the lane report.
type Props = {
  heads: LatLng[];
  routingStr: string;
  wasteStr: string;
  onAllowancesChange: (routingStr: string, wasteStr: string) => void;
};

export default function PipePanel({
  heads,
  routingStr,
  wasteStr,
  onAllowancesChange,
}: Props) {
  const routingPct = Number(routingStr);
  const wastePct = Number(wasteStr);
  const routingValid = routingStr.trim() === "" || (Number.isFinite(routingPct) && routingPct >= 0);
  const wasteValid = wasteStr.trim() === "" || (Number.isFinite(wastePct) && wastePct >= 0);

  const pipe: PipeEstimate =
    heads.length < 2
      ? { straightLineFt: 0, routedFt: 0, totalFt: 0, routingPct: 0, wastePct: 0, headCount: heads.length, segments: [] }
      : pipeEstimate(heads, {
          routingPct: Number.isFinite(routingPct) ? routingPct : 0,
          wastePct: Number.isFinite(wastePct) ? wastePct : 0,
        });

  if (heads.length < 2) {
    return (
      <p className="text-xs text-gray-500">
        Place at least two sprinkler heads on the map to measure pipe between them.
      </p>
    );
  }

  const ft = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

  return (
    <div className="space-y-2">
      <dl className="space-y-0.5 text-xs text-gray-700">
        <div className="flex justify-between gap-2">
          <dt>Straight line</dt>
          <dd className="tabular-nums font-medium">{ft(pipe.straightLineFt)} ft</dd>
        </div>
        <div className="flex justify-between gap-2 text-gray-500">
          <dt>
            + {pipe.routingPct}% routing{" "}
            <span className="text-gray-400">(the trench you will dig)</span>
          </dt>
          <dd className="tabular-nums">{ft(pipe.routedFt)} ft</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>
            + {pipe.wastePct}% waste <span className="text-gray-400">(the pipe you buy)</span>
          </dt>
          <dd className="tabular-nums font-semibold">{ft(pipe.totalFt)} ft</dd>
        </div>
      </dl>

      <div className="grid grid-cols-2 gap-1.5">
        <label>
          <span className="text-[11px] font-medium text-gray-700">Routing allowance %</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            aria-label="Routing allowance percent"
            value={routingStr}
            onChange={(e) => onAllowancesChange(e.target.value, wasteStr)}
            className={`mt-0.5 w-full rounded border px-2 py-1 text-xs ${
              routingValid ? "border-gray-300" : "border-red-400"
            }`}
          />
        </label>
        <label>
          <span className="text-[11px] font-medium text-gray-700">Waste allowance %</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            aria-label="Waste allowance percent"
            value={wasteStr}
            onChange={(e) => onAllowancesChange(routingStr, e.target.value)}
            className={`mt-0.5 w-full rounded border px-2 py-1 text-xs ${
              wasteValid ? "border-gray-300" : "border-red-400"
            }`}
          />
        </label>
      </div>
      <p className="text-[11px] text-gray-500">
        Routing is how much longer the trench runs than the straight line — beds,
        drives, zone splits (typically 20-40%). Waste is cut-offs and breakage on
        that run (typically 5-10%). They compound, not add.
      </p>

      <div className="rounded bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-800">
        The straight-line figure is a floor: it is the shortest run that connects
        the {pipe.headCount} head{pipe.headCount === 1 ? "" : "s"} placed, and it
        excludes the mainline from the point of connection, the backflow and the
        run to the controller — none of those are placed on the map. Price those
        under Parts.
      </div>
    </div>
  );
}