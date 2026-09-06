"use client";

// Sod panel (Lane C). Sod attaches to a MEASURED AREA — the polygon is already
// on the map — so this panel never places anything; it assigns a catalogue
// product to an area and reads the calculator back.
//
// Three numbers belong on screen together, because each answers a different
// question: gross sqft is what the customer buys, pallets is what you order,
// and leftover is what you paid for and will not lay.
//
// The pallet size is EDITABLE PER JOB: a farm ships 500 one week and 400 the
// next, and on this job that is the difference between 11 pallets and 12.
// Editing writes the snapshot into the area's meta — it must never touch the
// catalogue. The workspace does the write; this panel is presentational.

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  describePallet,
  palletSizeUnset,
  sodLineItem,
  type SodEstimate,
  type SodSnapshot,
} from "@/lib/sodProducts";
import type { EstimatorLine } from "./types";

export type SodAreaRow = {
  areaId: string;
  name: string;
  netSqft: number;
  snapshot: SodSnapshot;
  estimate: SodEstimate;
};

export type SodCandidate = {
  id: string;
  name: string;
  area_sqft: number;
};

type Props = {
  sodAreas: SodAreaRow[];
  bareAreas: SodCandidate[];
  products: { id: string; name: string; grass_type: string }[];
  canEdit: boolean;
  saving: boolean;
  onAssign: (areaId: string, productId: string, wastePct: number) => void;
  onOverridePallet: (areaId: string, sqftPerPallet: number) => void;
  onRemove: (areaId: string) => void;
  onAddLines: (lines: EstimatorLine[]) => void;
};

export default function SodPanel({
  sodAreas,
  bareAreas,
  products,
  canEdit,
  saving,
  onAssign,
  onOverridePallet,
  onRemove,
  onAddLines,
}: Props) {
  // Assign form state. Waste defaults to 10% — the cutting allowance in the
  // lane example — but every job can change it; it is stored on the snapshot.
  const [assignAreaId, setAssignAreaId] = useState("");
  const [assignProductId, setAssignProductId] = useState("");
  const [assignWaste, setAssignWaste] = useState("10");
  // Per-area pallet override drafts, keyed by area id. String state so the box
  // can be empty while editing; "" on blur means "keep the snapshot's value".
  const [palletDrafts, setPalletDrafts] = useState<Record<string, string>>({});

  const waste = Number(assignWaste);
  const assignReady = assignAreaId !== "" && assignProductId !== "" && (!assignWaste.trim() || (Number.isFinite(waste) && waste >= 0 && waste < 100));

  // sodLineItem returns null when there is nothing billable — respect it, no
  // $0 sod line reaches a quote. Re-derived nothing: the contract does the math.
  const lines: EstimatorLine[] = sodAreas.flatMap((row) => {
    const line = sodLineItem(row.snapshot.name, row.estimate, row.snapshot.cost_per_sqft);
    return line ? [line] : [];
  });

  return (
    <div className="space-y-2">
      {sodAreas.length === 0 && (
        <p className="text-xs text-gray-500">
          Draw an area on the map, then assign sod to it below.
        </p>
      )}

      {sodAreas.map((row) => {
        const est = row.estimate;
        const snap = row.snapshot;
        const draft = palletDrafts[row.areaId] ?? "";
        return (
          <div
            key={row.areaId}
            className="space-y-1 rounded border border-gray-200 bg-white p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900">
                {row.name}
              </p>
              <p className="shrink-0 text-xs tabular-nums text-gray-500">
                {est.netSqft.toLocaleString(undefined, { maximumFractionDigits: 0 })} sq ft measured
              </p>
            </div>

            <dl className="space-y-0.5 text-xs text-gray-700">
              <div className="flex justify-between gap-2">
                <dt>
                  + {est.wastePct}% cutting waste
                </dt>
                <dd className="tabular-nums">
                  → {est.grossSqft.toLocaleString(undefined, { maximumFractionDigits: 0 })} to cover
                </dd>
              </div>
              {est.pallets !== null ? (
                <>
                  <div className="flex justify-between gap-2 font-medium">
                    <dt>Pallets to order</dt>
                    <dd className="tabular-nums">{est.pallets}</dd>
                  </div>
                  <div className="flex justify-between gap-2 text-gray-500">
                    <dt className="sr-only">Purchased</dt>
                    <dd className="tabular-nums">
                      {est.purchasedSqft?.toLocaleString(undefined, { maximumFractionDigits: 0 })} sq ft bought
                      {est.leftoverSqft !== null && est.leftoverSqft > 0
                        ? ` · ${est.leftoverSqft.toLocaleString(undefined, { maximumFractionDigits: 0 })} sq ft left over`
                        : ""}
                    </dd>
                  </div>
                </>
              ) : (
                <div className="text-amber-700">
                  Pallet count unknown — {describePallet(snap.sqft_per_pallet)}.
                </div>
              )}
              <div className="flex justify-between gap-2 text-gray-500">
                <dt>Billed</dt>
                <dd className="tabular-nums">
                  {formatMoney(est.revenue)} (cost {formatMoney(est.cost)} ·{" "}
                  {est.manHours} man-hrs)
                </dd>
              </div>
            </dl>

            <p className="text-[11px] text-gray-500">{describePallet(snap.sqft_per_pallet)}</p>

            {canEdit && (
              <div className="flex items-center gap-1.5">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Pallet size for this job (sq ft per pallet)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    placeholder={snap.sqft_per_pallet > 0 ? String(snap.sqft_per_pallet) : "sq ft per pallet"}
                    value={draft}
                    onChange={(e) =>
                      setPalletDrafts((d) => ({ ...d, [row.areaId]: e.target.value }))
                    }
                    onBlur={() => {
                      const t = draft.trim();
                      if (t === "") return; // empty keeps the job's snapshot
                      const n = Number(t);
                      if (!Number.isFinite(n) || n <= 0) return;
                      // Only write when it actually differs — a no-op write
                      // would touch every open estimate for nothing.
                      if (Math.round(n) === Math.round(snap.sqft_per_pallet)) return;
                      onOverridePallet(row.areaId, n);
                    }}
                    disabled={saving}
                    className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                </label>
                <span className="shrink-0 text-[11px] text-gray-500">sq ft/pallet, this job only</span>
                <button
                  type="button"
                  aria-label={`Remove sod from ${row.name}`}
                  onClick={() => onRemove(row.areaId)}
                  disabled={saving}
                  className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {canEdit && bareAreas.length > 0 && products.length > 0 && (
        <div className="space-y-1.5 rounded border border-gray-200 bg-gray-50 p-2">
          <p className="text-xs font-medium text-gray-700">Assign sod to an area</p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
            <select
              aria-label="Area to sod"
              className="rounded border border-gray-300 px-2 py-1 text-xs"
              value={assignAreaId}
              onChange={(e) => setAssignAreaId(e.target.value)}
              disabled={saving}
            >
              <option value="">Area…</option>
              {bareAreas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.area_sqft.toLocaleString(undefined, { maximumFractionDigits: 0 })} sq ft)
                </option>
              ))}
            </select>
            <select
              aria-label="Sod product"
              className="rounded border border-gray-300 px-2 py-1 text-xs"
              value={assignProductId}
              onChange={(e) => setAssignProductId(e.target.value)}
              disabled={saving}
            >
              <option value="">Sod…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label>
              <span className="sr-only">Cutting waste percent</span>
              <input
                type="number"
                min="0"
                max="99"
                step="1"
                inputMode="numeric"
                aria-label="Cutting waste percent"
                value={assignWaste}
                onChange={(e) => setAssignWaste(e.target.value)}
                disabled={saving}
                className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
              />
            </label>
          </div>
          <p className="text-[11px] text-gray-500">
            Cutting waste covers cuts around beds and edges — it is billed; pallets are what you order.
          </p>
          <button
            type="button"
            disabled={!assignReady || saving}
            onClick={() => onAssign(assignAreaId, assignProductId, assignWaste.trim() ? waste : 0)}
            className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "Assign sod"}
          </button>
        </div>
      )}

      {sodAreas.length > 0 && (
        <button
          type="button"
          disabled={!canEdit || saving || lines.length === 0}
          onClick={() => onAddLines(lines)}
          className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="mx-auto h-3 w-3 animate-spin" />
          ) : lines.length === 0 ? (
            "Nothing billable — a price is missing"
          ) : (
            `Add sod to estimate (${lines.length} ${lines.length === 1 ? "line" : "lines"})`
          )}
        </button>
      )}
      {sodAreas.some((r) => palletSizeUnset(r.snapshot)) && (
        <p className="text-[11px] text-amber-700">
          A sodded area has no pallet size, so its pallet count is not shown. Enter what your farm ships —
          it is editable above, per job.
        </p>
      )}
    </div>
  );
}