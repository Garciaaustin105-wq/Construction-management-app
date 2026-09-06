"use client";

// Drip panel (Lane C). Emitters are COUNTED FROM THE PLANTS ALREADY ON THE
// MAP, never placed: set an emitter product and a per-category rule ("every
// tree 4, every shrub 1"), stored in estimates.drip_config. Placing a tree
// then prices its drip with no extra clicks.
//
// THE HEAD-OVERLAP PROMPT IS THE INTERESTING PART. plantsInHeadCoverage says
// which plants sit inside a placed head's throw — a MEASUREMENT, not a
// recommendation: whether a plant under a canopy the spray never reaches is
// adequately watered is the designer's call. So the prompt offers Leave /
// Remove and NOTHING happens without a choice: dripTally drops nothing unless
// the ids are passed in. Silently removing emitters would lose a plant's
// water with nobody seeing it happen.
//
// Remove persists the exclusion in drip_config. Leave dismisses for this
// session only — a new head or a new plant should ask again, because the
// geometry changed and the old answer is about old geometry.

import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  dripLineItem,
  dripTally,
  type CoveredPlant,
  type DripConfig,
  type DripEmitter,
  type IrrigationNozzle,
  type IrrigationProduct,
} from "@/lib/irrigationProducts";
import { PLANT_CATEGORIES, type PlantCategory } from "@/lib/plantProducts";
import type { EstimateArea } from "@/lib/estimateAreas";
import type { EstimatorLine } from "./types";

const CATEGORY_LABEL: Record<PlantCategory, string> = {
  tree: "Trees",
  palm: "Palms",
  shrub: "Shrubs",
  perennial: "Perennials",
  grass: "Ornamental grass",
  annual: "Annuals",
  groundcover: "Groundcover",
  vine: "Vines",
};

export type DripEmitterOption = {
  product: IrrigationProduct;
  nozzles: IrrigationNozzle[];
};

type Props = {
  areas: EstimateArea[];
  config: DripConfig;
  excludedPlantIds: string[];
  covered: CoveredPlant[];
  emitterOptions: DripEmitterOption[];
  canEdit: boolean;
  saving: boolean;
  onSave: (config: DripConfig, excludedPlantIds: string[]) => void;
  onAddLine: (line: EstimatorLine) => void;
};

export default function DripPanel({
  areas,
  config,
  excludedPlantIds,
  covered,
  emitterOptions,
  canEdit,
  saving,
  onSave,
  onAddLine,
}: Props) {
  // Overlap prompt state: Leave dismisses for the session. Remove persists.
  const [overlapDismissed, setOverlapDismissed] = useState(false);

  const excluded = useMemo(() => new Set(excludedPlantIds), [excludedPlantIds]);
  // Plants the prompt is still waiting on: inside a head's throw, not already
  // excluded, and not dismissed with Leave this session.
  const openOverlap = overlapDismissed
    ? []
    : covered.filter((c) => !excluded.has(c.plantAreaId));

  const tally = useMemo(
    () => dripTally(areas, config, excluded),
    [areas, config, excluded]
  );

  // Local drafts for the per-category rule, keyed by category. Committed on
  // blur; empty means "remove the rule" (0 is stored, which reads as none).
  const [ruleDrafts, setRuleDrafts] = useState<Partial<Record<PlantCategory, string>>>({});
  const [emitterProductId, setEmitterProductId] = useState(
    emitterOptions.find((o) => o.product.id === config.emitter?.irrigation_product_id)?.product.id ?? ""
  );
  const [emitterNozzleId, setEmitterNozzleId] = useState(config.emitter?.irrigation_nozzle_id ?? "");

  const categoriesWithPlants = new Set(
    tally.byCategory.map((b) => b.category)
  );

  const commitRule = (category: PlantCategory, raw: string) => {
    const t = raw.trim();
    const n = t === "" ? 0 : Math.round(Number(t));
    if (!Number.isFinite(n) || n < 0) return;
    // Only write when the rule actually changed — a blur on an untouched
    // field must not fire a save.
    const current = config.perCategory[category] ?? 0;
    if (n === current) return;
    onSave(
      { ...config, perCategory: { ...config.perCategory, [category]: n } },
      excludedPlantIds
    );
  };

  const commitEmitter = (productId: string, nozzleId: string) => {
    if (!productId || !nozzleId) return;
    const option = emitterOptions.find((o) => o.product.id === productId);
    const nozzle = option?.nozzles.find((n) => n.id === nozzleId);
    if (!option || !nozzle) return;
    const emitter: DripEmitter = {
      irrigation_product_id: option.product.id,
      irrigation_nozzle_id: nozzle.id,
      name: option.product.name,
      nozzle: nozzle.nozzle,
      cost: nozzle.cost,
      unit_price: nozzle.unit_price,
      install_minutes: nozzle.install_minutes,
    };
    onSave({ ...config, emitter }, excludedPlantIds);
  };

  const clearEmitter = () => onSave({ ...config, emitter: null }, excludedPlantIds);

  const line = dripLineItem(tally, config);

  const openHeadName = openOverlap.length > 0 ? openOverlap[0].headName : "";

  return (
    <div className="space-y-2">
      {/* Emitter product */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-700">Emitter</p>
        {emitterOptions.length === 0 ? (
          <p className="text-xs text-gray-500">
            No drip products in the catalogue yet — add one under Products.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <select
                aria-label="Emitter product"
                className="rounded border border-gray-300 px-2 py-1 text-xs"
                value={emitterProductId}
                onChange={(e) => {
                  const id = e.target.value;
                  setEmitterProductId(id);
                  const first = emitterOptions.find((o) => o.product.id === id)?.nozzles[0];
                  const nid = first?.id ?? "";
                  setEmitterNozzleId(nid);
                  if (id && nid) commitEmitter(id, nid);
                }}
                disabled={!canEdit || saving}
              >
                <option value="">Product…</option>
                {emitterOptions.map((o) => (
                  <option key={o.product.id} value={o.product.id}>
                    {o.product.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Emitter nozzle"
                className="rounded border border-gray-300 px-2 py-1 text-xs"
                value={emitterNozzleId}
                onChange={(e) => {
                  setEmitterNozzleId(e.target.value);
                  commitEmitter(emitterProductId, e.target.value);
                }}
                disabled={!canEdit || saving || !emitterProductId}
              >
                <option value="">Nozzle…</option>
                {emitterOptions
                  .find((o) => o.product.id === emitterProductId)
                  ?.nozzles.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.nozzle}
                    </option>
                  ))}
              </select>
            </div>
            {config.emitter && canEdit && (
              <button
                type="button"
                onClick={clearEmitter}
                disabled={saving}
                className="text-[11px] text-gray-500 underline hover:text-gray-700"
              >
                Clear the emitter
              </button>
            )}
          </>
        )}
      </div>

      {/* Per-category rules */}
      {config.emitter && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-700">
            Emitters per plant, by category
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {PLANT_CATEGORIES.map((cat) => {
              const current = config.perCategory[cat] ?? 0;
              const draft = ruleDrafts[cat];
              return (
                <label key={cat} className="flex items-center gap-1">
                  <span
                    className={`min-w-0 flex-1 truncate text-[11px] ${
                      categoriesWithPlants.has(cat) ? "text-gray-700" : "text-gray-400"
                    }`}
                  >
                    {CATEGORY_LABEL[cat]}
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    aria-label={`Emitters per ${CATEGORY_LABEL[cat]}`}
                    placeholder={String(current)}
                    value={draft ?? ""}
                    onChange={(e) =>
                      setRuleDrafts((d) => ({ ...d, [cat]: e.target.value }))
                    }
                    onBlur={(e) => {
                      commitRule(cat, e.target.value);
                      setRuleDrafts((d) => {
                        const rest = { ...d };
                        delete rest[cat];
                        return rest;
                      });
                    }}
                    disabled={!canEdit || saving}
                    className="w-14 shrink-0 rounded border border-gray-300 px-1.5 py-0.5 text-xs"
                  />
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-gray-500">
            A plant overrides its category rule when it carries its own emitter count.
          </p>
        </div>
      )}

      {/* The head-overlap prompt. Rendered only while plants are still
          undecided — excluded plants and a session Leave both clear it. */}
      {openOverlap.length > 0 && config.emitter && (
        <div className="space-y-1.5 rounded border border-amber-200 bg-amber-50 p-2">
          <p className="text-xs text-amber-900">
            {openOverlap.length} plant{openOverlap.length === 1 ? " is" : "s are"} inside a{" "}
            {openHeadName}&apos;s throw. Leave their emitters, or remove them?
          </p>
          <p className="text-[11px] leading-snug text-amber-800">
            Being inside the throw does not mean adequately watered — canopy, soil
            and run time decide that. This only measures the geometry.
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setOverlapDismissed(true)}
              className="flex-1 rounded bg-white px-2 py-1 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
            >
              Leave
            </button>
            <button
              type="button"
              onClick={() => {
                onSave(config, [
                  ...excludedPlantIds,
                  ...openOverlap.map((c) => c.plantAreaId),
                ]);
              }}
              disabled={saving}
              className="flex-1 rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Tally */}
      {config.emitter ? (
        <dl className="space-y-0.5 text-xs text-gray-700">
          <div className="flex justify-between gap-2">
            <dt>Emitters</dt>
            <dd className="tabular-nums font-medium">
              {tally.emitters} on {tally.plantsWithDrip} plant
              {tally.plantsWithDrip === 1 ? "" : "s"}
            </dd>
          </div>
          {tally.overriddenPlants > 0 && (
            <div className="text-gray-500">
              {tally.overriddenPlants} plant{tally.overriddenPlants === 1 ? "" : "s"} carry their own
              count, overriding the rule.
            </div>
          )}
          {excludedPlantIds.length > 0 && (
            <div className="text-gray-500">
              {excludedPlantIds.length} plant{excludedPlantIds.length === 1 ? " has" : "s have"} emitters
              removed — they were inside a head&apos;s throw.
            </div>
          )}
          {tally.byCategory.map((b) => (
            <div key={b.category} className="flex justify-between gap-2 text-gray-500">
              <dt>{CATEGORY_LABEL[b.category]}</dt>
              <dd className="tabular-nums">
                {b.plants} × → {b.emitters}
              </dd>
            </div>
          ))}
          <div className="flex justify-between gap-2">
            <dt>Billed</dt>
            <dd className="tabular-nums">
              {formatMoney(tally.revenue)} (cost {formatMoney(tally.cost)} ·{" "}
              {tally.manHours} man-hrs)
            </dd>
          </div>
        </dl>
      ) : (
        emitterOptions.length > 0 && (
          <p className="text-xs text-gray-500">Pick an emitter to price drip.</p>
        )
      )}

      {line && (
        <button
          type="button"
          disabled={!canEdit || saving}
          onClick={() => onAddLine(line)}
          className="w-full rounded bg-green-600 px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="mx-auto h-3 w-3 animate-spin" />
          ) : (
            `Add drip to estimate (${formatMoney(tally.revenue)})`
          )}
        </button>
      )}
    </div>
  );
}