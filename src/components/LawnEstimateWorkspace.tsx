"use client";

// Lawn estimating workspace (client). A map application, not a page with a
// map in it: the shell fills the viewport (h-dvh, never h-screen — mobile
// browser chrome makes 100vh taller than the visible area) and never scrolls;
// the map canvas fills the shell and everything else floats over it — a
// compact bar (back, title, save state) and the map's own floating panel,
// which carries BOTH the area controls and the line items, so nothing is ever
// reached by switching pages or tabs.
//
// Line-item persistence FOLLOWS the shared page's save path
// (/estimates/[id]/page.tsx saveEstimate): read all rows, append, delete the
// estimate's items, reinsert with fresh positions and the same column mapping
// (recurring_schedule_id intentionally NOT re-inserted — route-stamp only).
// Same guards too: only draft estimates accept writes. RLS scopes every query
// — no manual organization_id filters.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileText, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import LawnMeasurementMap from "@/components/LawnMeasurementMap";
import StatusBadge from "@/components/ui/StatusBadge";
import {
  ESTIMATE_STATUS_LABEL,
  ESTIMATE_STATUS_TONE,
  type EstimateStatus,
} from "@/lib/lifecycles/estimate";
import {
  computeEstimateTotals,
  computeTotal,
  formatMoney,
} from "@/lib/money";
import {
  updateEstimateArea,
  type EstimateArea,
} from "@/lib/estimateAreas";
import { buildPlantLegend } from "@/lib/plantProducts";
import {
  headPoints,
  pipeEstimate,
  plantsInHeadCoverage,
  readDripConfig,
  listIrrigationCatalogue,
  type DripConfig,
  type IrrigationWithNozzles,
} from "@/lib/irrigationProducts";
import {
  listSodProducts,
  sodEstimateForArea,
  sodSnapshot,
  readSodSnapshot,
  type SodProduct,
} from "@/lib/sodProducts";
import {
  listComponents,
  readComponentSnapshot,
  componentCharge,
  componentLineItem,
  componentSnapshot,
  type IrrigationComponent,
} from "@/lib/irrigationSystem";
import {
  equipmentSnapshot,
  listEquipment,
  readEquipmentSnapshot,
  type EquipmentProduct,
} from "@/lib/equipmentProducts";
import {
  laborCharge,
  laborLineItem,
  laborSnapshot,
  listLaborItems,
  readLaborSnapshot,
  type LaborItem,
} from "@/lib/laborItems";
import LandscapeLaborPanel from "@/components/LandscapeLaborPanel";
import SodPanel from "@/components/estimator/SodPanel";
import PipePanel from "@/components/estimator/PipePanel";
import DripPanel from "@/components/estimator/DripPanel";
import EquipmentPanel from "@/components/estimator/EquipmentPanel";
import LaborItemsPanel from "@/components/estimator/LaborItemsPanel";
import ComponentsPanel from "@/components/estimator/ComponentsPanel";
import type { EquipmentRow } from "@/components/estimator/EquipmentPanel";
import type { LaborRow } from "@/components/estimator/LaborItemsPanel";
import type { ComponentRow } from "@/components/estimator/ComponentsPanel";

// Same office line-item columns the shared page reads so a rewrite here
// round-trips exactly what saveEstimate would have written back.
const ITEM_SELECT =
  "id, cost_code_id, description, quantity, unit, unit_price, internal_cost, section, schedule_frequency, schedule_interval_weeks, schedule_days_of_week, schedule_day_of_month, schedule_start_date, schedule_end_date, recurring_schedule_id";

type LineRow = {
  id: string;
  cost_code_id: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  internal_cost: number | null;
  section: string | null;
  schedule_frequency?: string | null;
  schedule_interval_weeks?: number;
  schedule_days_of_week?: number[];
  schedule_day_of_month?: number | null;
  schedule_start_date?: string | null;
  schedule_end_date?: string | null;
  recurring_schedule_id?: string | null;
};

type Estimate = {
  id: string;
  organization_id: string;
  title: string | null;
  status: string;
  markup_pct: number;
  contingency_pct: number;
  tax_pct: number;
  deposit_pct: number;
  deposit_amount: number;
  // Landscape install labor. Each is nullable and null means "not estimated",
  // which is NOT the same as 0 — see LandscapeLaborPanel.
  labor_rate: number | null;
  labor_cost_rate: number | null;
  mobilization_hours: number | null;
  // Drip rules: emitter choice, per-category counts, and the plant ids the
  // estimator chose to drop from drip. Raw jsonb — panels narrow it via
  // readDripConfig; this type holds the raw column.
  drip_config: Record<string, unknown> | null;
  jobs: { name: string; address: string | null } | null;
  customers: { name: string | null; address: string | null } | null;
};

export default function LawnEstimateWorkspace({
  estimateId,
}: {
  estimateId: string;
}): React.ReactElement {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [items, setItems] = useState<LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [persisting, setPersisting] = useState(false);
  // The MAP owns areas; it publishes them up so the labor panel can build the
  // plant legend without a second fetch of the same rows.
  const [areas, setAreas] = useState<EstimateArea[]>([]);
  const [savingLabor, setSavingLabor] = useState(false);

  // ── Estimator panels (Lane C) ───────────────────────────────────────────────
  // Which panel is open. The pipe allowances live HERE, not in PipePanel, so
  // the Parts panel's "use measured pipe" helper prices the SAME figure the
  // Pipe panel shows — one computation, two consumers. Defaults are the
  // mid-points of the contract's typical ranges (routing 20-40%, waste 5-10%).
  const [panelTab, setPanelTab] = useState("plants");
  const [routingStr, setRoutingStr] = useState("30");
  const [wasteStr, setWasteStr] = useState("10");
  // Panel writes are serialized and draft-only, matching saveLaborSettings.
  // persisting is in the mix too: addMeasuredLines (which the panels' add
  // buttons funnel through) no-ops silently while a line rewrite is in flight,
  // so the panels must not offer it then.
  const [panelBusy, setPanelBusy] = useState(false);

  // Catalogues, scoped to the estimate's org — fetched once per estimate.
  const [sodProducts, setSodProducts] = useState<SodProduct[]>([]);
  const [irrigationCatalogue, setIrrigationCatalogue] = useState<
    IrrigationWithNozzles[]
  >([]);
  const [componentItems, setComponentItems] = useState<IrrigationComponent[]>([]);
  const [laborItemCatalogue, setLaborItemCatalogue] = useState<LaborItem[]>([]);
  const [equipmentProducts, setEquipmentProducts] = useState<EquipmentProduct[]>([]);
  // Rows already on this estimate, parsed with the contract readers — never
  // cast, so a row written before a shape existed reads as absent, not NaN.
  const [equipmentRows, setEquipmentRows] = useState<EquipmentRow[]>([]);
  const [laborRows, setLaborRows] = useState<LaborRow[]>([]);
  const [componentRows, setComponentRows] = useState<ComponentRow[]>([]);

  const toast = useToast();

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      // RLS scopes both reads to the caller's org — a foreign estimate id
      // simply comes back empty.
      const [{ data: est }, { data: rows }] = await Promise.all([
        supabase
          .from("estimates")
          .select(
            "id, organization_id, title, status, markup_pct, contingency_pct, tax_pct, deposit_pct, deposit_amount, labor_rate, labor_cost_rate, mobilization_hours, drip_config, jobs(name, address), customers(name, address)"
          )
          .eq("id", estimateId)
          .maybeSingle(),
        supabase
          .from("estimate_line_items")
          .select(ITEM_SELECT)
          .eq("estimate_id", estimateId)
          .order("position"),
      ]);
      if (!est) {
        toast.error("Estimate not found");
        setLoading(false);
        return;
      }
      setEstimate(est as unknown as Estimate);
      setItems((rows as LineRow[] | null) ?? []);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateId]);

  // Panel catalogues (org-scoped) and any rows already on this estimate. Keyed
  // on the estimate id, not the object, so an optimistic estimate patch (e.g.
  // saveLaborSettings) never refetches. RLS scopes every read — no manual
  // organization_id filters.
  const estId = estimate?.id ?? null;
  const estOrgId = estimate?.organization_id ?? null;
  useEffect(() => {
    if (!estId || !estOrgId) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [sod, irr, comps, labor, equip] = await Promise.all([
        listSodProducts(supabase, estOrgId),
        listIrrigationCatalogue(supabase, estOrgId),
        listComponents(supabase, estOrgId),
        listLaborItems(supabase, estOrgId),
        listEquipment(supabase, estOrgId),
      ]);
      const [eqRows, lbRows, cpRows] = await Promise.all([
        supabase
          .from("estimate_equipment")
          .select("id, snapshot, quantity, hours, days")
          .eq("estimate_id", estId),
        supabase
          .from("estimate_labor_items")
          .select("id, snapshot, quantity")
          .eq("estimate_id", estId),
        supabase
          .from("estimate_components")
          .select("id, snapshot, quantity")
          .eq("estimate_id", estId),
      ]);
      if (cancelled) return;

      for (const r of [sod, irr, comps, labor, equip]) {
        if (r.error) toast.error(`Catalogue load failed: ${r.error}`);
      }
      setSodProducts(sod.data);
      setIrrigationCatalogue(irr.data);
      setComponentItems(comps.data);
      setLaborItemCatalogue(labor.data);
      setEquipmentProducts(equip.data);

      // Snapshots are parsed with the contract readers; a stale or foreign
      // shape reads as "not on the estimate" rather than as NaN prices.
      const eqParsed: EquipmentRow[] = [];
      for (const r of (eqRows.data ?? []) as unknown as {
        id: string;
        snapshot: unknown;
        quantity: number;
        hours: number;
        days: number;
      }[]) {
        const snap = readEquipmentSnapshot(r.snapshot);
        if (!snap) continue;
        eqParsed.push({
          id: r.id,
          line: { snapshot: snap, quantity: r.quantity, hours: r.hours, days: r.days },
          // Staleness is about the CATALOGUE's rate stamp, not the quote, so
          // the snapshot deliberately does not carry it — looked up here.
          ratesUpdatedAt:
            equip.data.find((p) => p.id === snap.equipment_product_id)?.rates_updated_at ?? null,
        });
      }
      setEquipmentRows(eqParsed);

      const lbParsed: LaborRow[] = [];
      for (const r of (lbRows.data ?? []) as unknown as {
        id: string;
        snapshot: unknown;
        quantity: number;
      }[]) {
        const snap = readLaborSnapshot(r.snapshot);
        if (snap) lbParsed.push({ id: r.id, snapshot: snap, quantity: r.quantity });
      }
      setLaborRows(lbParsed);

      const cpParsed: ComponentRow[] = [];
      for (const r of (cpRows.data ?? []) as unknown as {
        id: string;
        snapshot: unknown;
        quantity: number;
      }[]) {
        const snap = readComponentSnapshot(r.snapshot);
        if (snap) cpParsed.push({ id: r.id, snapshot: snap, quantity: r.quantity });
      }
      setComponentRows(cpParsed);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estId, estOrgId]);

  // ── Persist a map-priced line ──────────────────────────────────────────────
  // The shared page's write (saveEstimate): delete + reinsert everything with
  // fresh positions. We read fresh from the DB first so a line priced here
  // never clobbers rows the office added on the document page.
  type NewLine = {
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    internal_cost?: number | null;
  };

  // Adds ONE line. Kept for the map's per-area pricing, which adds one at a
  // time; it just delegates.
  async function addMeasuredLine(line: NewLine) {
    return addMeasuredLines([line]);
  }

  // Adds MANY in a single read-delete-reinsert. Calling addMeasuredLine in a
  // loop cannot work: `persisting` makes the second call return early, so all
  // but the first plant line would vanish without an error.
  async function addMeasuredLines(lines: {
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    // What the item costs US. Optional because measured lawn areas priced by
    // $/sq ft have no cost side; a plant placed from the catalogue does, and
    // it must reach estimate_line_items.internal_cost or jobProfitability
    // reports the whole sale as margin.
    internal_cost?: number | null;
  }[]) {
    if (!estimate || persisting || lines.length === 0) return;
    // Same guards as the shared page's saveEstimate — a converted estimate is
    // locked (the delete+reinsert would wipe the line→schedule stamp), and
    // only drafts accept writes.
    if (estimate.status === "converted") {
      toast.warning("This estimate is converted. Edit the schedules directly.");
      return;
    }
    if (estimate.status !== "draft") {
      toast.warning(
        "Only draft estimates can be edited. Use Revise to edit a sent or rejected estimate."
      );
      return;
    }
    setPersisting(true);
    const supabase = createClient();
    const { data: rows, error: readError } = await supabase
      .from("estimate_line_items")
      .select(ITEM_SELECT)
      .eq("estimate_id", estimate.id)
      .order("position");
    if (readError) {
      toast.error(`Save failed: ${readError.message}`);
      setPersisting(false);
      return;
    }
    const existing = (rows as LineRow[] | null) ?? [];
    const all: LineRow[] = [
      ...existing,
      ...lines.map((line, i) => ({
        id: `pending-${Date.now()}-${i}`,
        cost_code_id: null,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        internal_cost: line.internal_cost ?? null,
        section: "",
      })),
    ];

    const { error: deleteError } = await supabase
      .from("estimate_line_items")
      .delete()
      .eq("estimate_id", estimate.id);
    if (deleteError) {
      toast.error(`Save failed: ${deleteError.message}`);
      setPersisting(false);
      return;
    }
    // Same insert mapping as the shared page's saveEstimate.
    const lineInserts = all.map((item, idx) => ({
      estimate_id: estimate.id,
      cost_code_id: item.cost_code_id ?? null,
      description: (item.description ?? "").trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      section: item.section || null,
      internal_cost: item.internal_cost ?? null,
      position: idx,
      // recurring_schedule_id is intentionally NOT re-inserted here — it is
      // route-stamped only. Construction → null.
      schedule_frequency: item.schedule_frequency || null,
      schedule_interval_weeks: item.schedule_interval_weeks ?? 1,
      schedule_days_of_week: item.schedule_days_of_week ?? [],
      schedule_day_of_month: item.schedule_day_of_month ?? null,
      schedule_start_date: item.schedule_start_date || null,
      schedule_end_date: item.schedule_end_date || null,
    }));
    const { error: insertError } = await supabase
      .from("estimate_line_items")
      .insert(lineInserts);
    if (insertError) {
      toast.error(`Save failed: ${insertError.message}`);
      setPersisting(false);
      return;
    }
    setItems(all);
    toast.success("Line item added");
    setPersisting(false);
  }

  if (loading || !estimate) {
    return (
      <div className="fixed inset-x-0 top-0 z-[60] flex h-dvh items-center justify-center bg-gray-50 lg:left-64">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  const address = estimate.customers?.address ?? estimate.jobs?.address ?? null;
  const editable = estimate.status === "draft";
  const pricing = {
    markupPct: estimate.markup_pct,
    contingencyPct: estimate.contingency_pct,
    taxPct: estimate.tax_pct,
    depositPct: estimate.deposit_pct,
    depositAmount: estimate.deposit_amount,
  };
  const totals = computeEstimateTotals(items, pricing);

  const stripLines = (
    <ul className="divide-y divide-gray-100">
      {items.map((item) => (
        <li key={item.id} className="flex items-baseline justify-between gap-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-gray-700">
            {item.description || "Untitled line"}
            <span className="ml-1 text-gray-400">
              · {item.quantity} {item.unit ?? ""} @ {formatMoney(item.unit_price)}
            </span>
          </span>
          <span className="flex-shrink-0 text-xs font-semibold text-gray-900">
            {formatMoney(item.quantity * item.unit_price)}
          </span>
        </li>
      ))}
      {items.length === 0 && (
        <li className="py-1.5 text-xs text-gray-400">
          No line items yet — price an area on the map.
        </li>
      )}
    </ul>
  );

  const totalsRows = (
    <div className="space-y-0.5 border-t border-gray-200 pt-1.5 text-xs">
      <div className="flex justify-between text-gray-600">
        <span>Subtotal</span>
        <span>{formatMoney(computeTotal(items))}</span>
      </div>
      {totals.markupAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Markup ({Number(estimate.markup_pct) || 0}%)</span>
          <span>{formatMoney(totals.markupAmount)}</span>
        </div>
      )}
      {totals.contingencyAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Contingency ({Number(estimate.contingency_pct) || 0}%)</span>
          <span>{formatMoney(totals.contingencyAmount)}</span>
        </div>
      )}
      {totals.taxAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Tax ({Number(estimate.tax_pct) || 0}%)</span>
          <span>{formatMoney(totals.taxAmount)}</span>
        </div>
      )}
      <div className="flex justify-between text-sm font-bold text-gray-900">
        <span>Total</span>
        <span>{formatMoney(totals.grandTotal)}</span>
      </div>
      {totals.depositAmount > 0 && (
        <div className="flex justify-between text-gray-600">
          <span>Deposit</span>
          <span>{formatMoney(totals.depositAmount)}</span>
        </div>
      )}
    </div>
  );

  // The first estimate-LEVEL write in this component (line items go through
  // the delete-and-reinsert path above). A plain scoped update: RLS confirms
  // the estimate is ours, and only draft estimates accept writes, matching
  // every other save here.
  async function saveLaborSettings(patch: {
    labor_rate?: number | null;
    labor_cost_rate?: number | null;
    mobilization_hours?: number | null;
  }) {
    if (!estimate || savingLabor) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    setSavingLabor(true);
    // Optimistic: the panel's numbers should move as soon as the field blurs,
    // not after the round trip. Rolled back below if the write fails.
    const previous = estimate;
    setEstimate({ ...estimate, ...patch });
    const supabase = createClient();
    const { error } = await supabase
      .from("estimates")
      .update(patch)
      .eq("id", estimate.id);
    if (error) {
      setEstimate(previous);
      toast.error(`Save failed: ${error.message}`);
    }
    setSavingLabor(false);
  }

  // ── Panel writers ─────────────────────────────────────────────────────────
  // Every write the panels trigger: draft-only, serialized (panelBusy, and
  // persisting because the billable lines funnel through addMeasuredLines,
  // which silently no-ops mid-rewrite), RLS-scoped — no manual org filters.
  // Optimistic state rolls back on error, matching saveLaborSettings.

  // One meta write to a drawn area, optimistic with rollback. The MAP owns its
  // areas state and has no external reload seam; it converges on its next
  // loadAreas(), and meta never affects polygon or marker rendering, so the
  // optimistic copy is what keeps the panels reading fresh values.
  async function writeAreaMeta(areaId: string, meta: Record<string, unknown>) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    setPanelBusy(true);
    const prev = areas;
    setAreas(areas.map((a) => (a.id === areaId ? { ...a, meta } : a)));
    const error = await updateEstimateArea(createClient(), areaId, { meta });
    if (error) {
      setAreas(prev);
      toast.error(`Save failed: ${error}`);
    }
    setPanelBusy(false);
  }

  // Sod meta is written FLAT into the area's meta — exactly the keys
  // readSodSnapshot narrows — merged into whatever is already there, because a
  // note or an emitter override can share the same meta object. Re-pricing the
  // catalogue must not move this job: these are snapshot values, not ids.
  const SOD_META_KEYS = [
    "sod_product_id",
    "name",
    "grass_type",
    "sqft_per_pallet",
    "cost_per_sqft",
    "price_per_sqft",
    "install_minutes_per_1000_sqft",
    "waste_pct",
  ] as const;

  function assignSod(areaId: string, productId: string, wastePct: number) {
    const product = sodProducts.find((p) => p.id === productId);
    const area = areas.find((a) => a.id === areaId);
    if (!product || !area) return;
    const meta = { ...area.meta, ...sodSnapshot(product, wastePct) };
    void writeAreaMeta(areaId, meta);
  }

  // The pallet size recorded FOR THIS JOB — never a catalogue edit.
  function overrideSodPallet(areaId: string, sqftPerPallet: number) {
    const area = areas.find((a) => a.id === areaId);
    if (!area) return;
    const meta = { ...area.meta, sqft_per_pallet: Math.round(sqftPerPallet) };
    void writeAreaMeta(areaId, meta);
  }

  function removeSod(areaId: string) {
    const area = areas.find((a) => a.id === areaId);
    if (!area) return;
    const meta = { ...area.meta };
    for (const k of SOD_META_KEYS) delete meta[k];
    void writeAreaMeta(areaId, meta);
  }

  // The WHOLE drip_config column is read-modify-written: readDripConfig drops
  // unknown keys by design, so the estimator's plant exclusions ride in the
  // same jsonb as the emitter and rules — written alongside, never clobbering
  // anything else stored there. Zero counts are stored as-is; readDripConfig
  // already treats them as "no drip on this category".
  async function saveDrip(config: DripConfig, excludedPlantIds: string[]) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    setPanelBusy(true);
    const raw = (estimate.drip_config ?? {}) as Record<string, unknown>;
    const next = {
      ...raw,
      emitter: config.emitter,
      per_category: config.perCategory,
      excluded_plant_ids: excludedPlantIds,
    };
    const prev = estimate;
    setEstimate({ ...estimate, drip_config: next });
    const { error } = await createClient()
      .from("estimates")
      .update({ drip_config: next })
      .eq("id", estimate.id);
    if (error) {
      setEstimate(prev);
      toast.error(`Save failed: ${error.message}`);
    }
    setPanelBusy(false);
  }

  // Adds a machine to estimate_equipment — the FIRST write to this table.
  // Quantity is whole machines; hours and days are separate NUMERIC columns
  // because they are different quantities on the same row (hours for owned,
  // days for rented) and the wrong one is silence, not an error.
  function addEquipment(productId: string, quantity: number, hours: number, days: number) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    const product = equipmentProducts.find((p) => p.id === productId);
    if (!product) return;
    setPanelBusy(true);
    const supabase = createClient();
    void (async () => {
      const { data, error } = await supabase
        .from("estimate_equipment")
        .insert({
          estimate_id: estimate.id,
          organization_id: estimate.organization_id,
          equipment_product_id: product.id,
          snapshot: equipmentSnapshot(product),
          quantity: Math.max(1, Math.floor(quantity)),
          hours,
          days,
        })
        .select("id, snapshot, quantity, hours, days")
        .single();
      if (error || !data) {
        toast.error(error ? `Save failed: ${error.message}` : "Save failed");
        setPanelBusy(false);
        return;
      }
      const snap = readEquipmentSnapshot(data.snapshot);
      if (snap) {
        setEquipmentRows((rows) => [
          ...rows,
          {
            id: data.id,
            line: { snapshot: snap, quantity: data.quantity, hours: data.hours, days: data.days },
            ratesUpdatedAt: product.rates_updated_at,
          },
        ]);
      }
      setPanelBusy(false);
    })();
  }

  function removeEquipmentRow(rowId: string) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    setPanelBusy(true);
    void (async () => {
      const { error } = await createClient()
        .from("estimate_equipment")
        .delete()
        .eq("id", rowId);
      if (error) toast.error(`Save failed: ${error.message}`);
      else setEquipmentRows((rows) => rows.filter((r) => r.id !== rowId));
      setPanelBusy(false);
    })();
  }

  // Adds a labor item row — the first write to estimate_labor_items — with a
  // full snapshot AND the billable line item, derived here from the same
  // charge the panel previewed. laborLineItem returns null when unpriced, so
  // an unpriced item writes its row (it IS on the estimate) but adds no line.
  function addLaborItemRow(itemId: string, quantity: number) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    const item = laborItemCatalogue.find((i) => i.id === itemId);
    if (!item) return;
    setPanelBusy(true);
    const supabase = createClient();
    void (async () => {
      const snap = laborSnapshot(item);
      const { data, error } = await supabase
        .from("estimate_labor_items")
        .insert({
          estimate_id: estimate.id,
          organization_id: estimate.organization_id,
          labor_item_id: item.id,
          snapshot: snap,
          quantity,
        })
        .select("id, snapshot, quantity")
        .single();
      if (error || !data) {
        toast.error(error ? `Save failed: ${error.message}` : "Save failed");
        setPanelBusy(false);
        return;
      }
      const parsed = readLaborSnapshot(data.snapshot);
      if (parsed) {
        setLaborRows((rows) => [...rows, { id: data.id, snapshot: parsed, quantity: data.quantity }]);
      }
      const line = laborLineItem(laborCharge(snap, quantity));
      if (line) await addMeasuredLines([line]);
      setPanelBusy(false);
    })();
  }

  function removeLaborRow(rowId: string) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    setPanelBusy(true);
    void (async () => {
      const { error } = await createClient()
        .from("estimate_labor_items")
        .delete()
        .eq("id", rowId);
      if (error) toast.error(`Save failed: ${error.message}`);
      else setLaborRows((rows) => rows.filter((r) => r.id !== rowId));
      setPanelBusy(false);
    })();
  }

  // Same pattern for irrigation components, writing estimate_components.
  function addComponentRow(componentId: string, quantity: number) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    const comp = componentItems.find((c) => c.id === componentId);
    if (!comp) return;
    setPanelBusy(true);
    const supabase = createClient();
    void (async () => {
      const snap = componentSnapshot(comp);
      const { data, error } = await supabase
        .from("estimate_components")
        .insert({
          estimate_id: estimate.id,
          organization_id: estimate.organization_id,
          irrigation_component_id: comp.id,
          snapshot: snap,
          quantity,
        })
        .select("id, snapshot, quantity")
        .single();
      if (error || !data) {
        toast.error(error ? `Save failed: ${error.message}` : "Save failed");
        setPanelBusy(false);
        return;
      }
      const parsed = readComponentSnapshot(data.snapshot);
      if (parsed) {
        setComponentRows((rows) => [...rows, { id: data.id, snapshot: parsed, quantity: data.quantity }]);
      }
      const line = componentLineItem(componentCharge(snap, quantity));
      if (line) await addMeasuredLines([line]);
      setPanelBusy(false);
    })();
  }

  function removeComponentRow(rowId: string) {
    if (!estimate || panelBusy || persisting) return;
    if (estimate.status !== "draft") {
      toast.warning("Only draft estimates can be edited.");
      return;
    }
    setPanelBusy(true);
    void (async () => {
      const { error } = await createClient()
        .from("estimate_components")
        .delete()
        .eq("id", rowId);
      if (error) toast.error(`Save failed: ${error.message}`);
      else setComponentRows((rows) => rows.filter((r) => r.id !== rowId));
      setPanelBusy(false);
    })();
  }

  // Derived from what is actually placed on the map — never stored. Polygons
  // and any non-plant points are ignored by buildPlantLegend itself.
  const plantLegend = buildPlantLegend(areas);

  // ── Estimator panel inputs, recomputed from the map on every render ───────
  const polygonAreas = areas.filter((a) => a.kind === "area");
  // Sod areas come from the CONTRACT calculator, reading the snapshot each
  // area's meta carries — never re-derived here.
  const sodAreaRows = polygonAreas.flatMap((a) => {
    const found = sodEstimateForArea(a);
    return found
      ? [{ areaId: a.id, name: a.name, netSqft: a.area_sqft, snapshot: found.snapshot, estimate: found.estimate }]
      : [];
  });
  const bareAreas = polygonAreas
    .filter((a) => readSodSnapshot(a) === null)
    .map((a) => ({ id: a.id, name: a.name, area_sqft: a.area_sqft }));

  const heads = headPoints(areas);
  const covered = plantsInHeadCoverage(areas);
  const dripConfig = readDripConfig(estimate.drip_config);
  // Exclusions live in the raw drip_config jsonb (written by saveDrip below);
  // narrow instead of cast, so a malformed value reads as "none excluded".
  const excludedPlantIds = (() => {
    const raw = estimate.drip_config;
    if (!raw || typeof raw !== "object") return [];
    const v = (raw as Record<string, unknown>).excluded_plant_ids;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  })();
  const emitterOptions = irrigationCatalogue
    .filter((c) => c.category === "drip" && c.nozzles.length > 0)
    .map((c) => ({ product: c, nozzles: c.nozzles }));

  // ONE pipe computation for both panels: Pipe displays it, Parts' "use
  // measured pipe" helper feeds the same total to buy into a foot row.
  const routingPct = Number(routingStr);
  const wastePct = Number(wasteStr);
  const pipe = pipeEstimate(heads, {
    routingPct: Number.isFinite(routingPct) && routingPct > 0 ? routingPct : 0,
    wastePct: Number.isFinite(wastePct) && wastePct > 0 ? wastePct : 0,
  });
  const pipeTotalFt = heads.length >= 2 ? pipe.totalFt : null;

  // Labor exists when placed plants are timed, labor rows are on the estimate,
  // or a mobilization figure is set — what the machines panel needs for its
  // "nobody to run it" warning.
  const hasLabor =
    plantLegend.some((r) => r.total_minutes > 0) ||
    laborRows.length > 0 ||
    (estimate.mobilization_hours ?? 0) > 0;

  const panelSaving = panelBusy || persisting;

  const PANEL_TABS = [
    { key: "plants", label: "Plants" },
    { key: "sod", label: "Sod" },
    { key: "pipe", label: "Pipe" },
    { key: "drip", label: "Drip" },
    { key: "parts", label: "Parts" },
    { key: "labor", label: "Labor" },
    { key: "machines", label: "Machines" },
  ] as const;

  const estimatorPanel = (() => {
    switch (panelTab) {
      case "plants":
        return (
          <LandscapeLaborPanel
            rows={plantLegend}
            laborRate={estimate.labor_rate}
            laborCostRate={estimate.labor_cost_rate}
            mobilizationHours={estimate.mobilization_hours}
            onChange={saveLaborSettings}
            saving={savingLabor}
            onAddPlantLines={addMeasuredLines}
            onAddLaborLine={addMeasuredLine}
            canEdit={editable}
          />
        );
      case "sod":
        return (
          <SodPanel
            sodAreas={sodAreaRows}
            bareAreas={bareAreas}
            products={sodProducts}
            canEdit={editable}
            saving={panelSaving}
            onAssign={assignSod}
            onOverridePallet={overrideSodPallet}
            onRemove={removeSod}
            onAddLines={(lines) => {
              void addMeasuredLines(lines);
            }}
          />
        );
      case "pipe":
        return (
          <PipePanel
            heads={heads}
            routingStr={routingStr}
            wasteStr={wasteStr}
            onAllowancesChange={(r, w) => {
              setRoutingStr(r);
              setWasteStr(w);
            }}
          />
        );
      case "drip":
        return (
          <DripPanel
            areas={areas}
            config={dripConfig}
            excludedPlantIds={excludedPlantIds}
            covered={covered}
            emitterOptions={emitterOptions}
            canEdit={editable}
            saving={panelSaving}
            onSave={(config, excluded) => {
              void saveDrip(config, excluded);
            }}
            onAddLine={(line) => {
              void addMeasuredLines([line]);
            }}
          />
        );
      case "parts":
        return (
          <ComponentsPanel
            components={componentItems}
            rows={componentRows}
            pipeTotalFt={pipeTotalFt}
            canEdit={editable}
            saving={panelSaving}
            onAdd={addComponentRow}
            onRemove={removeComponentRow}
          />
        );
      case "labor":
        return (
          <LaborItemsPanel
            items={laborItemCatalogue}
            rows={laborRows}
            areas={polygonAreas.map((a) => ({ id: a.id, name: a.name, area_sqft: a.area_sqft }))}
            canEdit={editable}
            saving={panelSaving}
            onAdd={addLaborItemRow}
            onRemove={removeLaborRow}
          />
        );
      case "machines":
        return (
          <EquipmentPanel
            products={equipmentProducts}
            rows={equipmentRows}
            hasLabor={hasLabor}
            canEdit={editable}
            saving={panelSaving}
            onAdd={addEquipment}
            onRemove={removeEquipmentRow}
            onAddLines={(lines) => {
              void addMeasuredLines(lines);
            }}
          />
        );
      default:
        return null;
    }
  })();

  // Injected into the map's floating panel (LawnMeasurementMap panelSlot):
  // the line-item section, so items are reachable WITHOUT leaving the map.
  // Includes the document hand-off — customer, terms, sending, the PDF and
  // the email preview all live on the shared page.
  const lineItemsSection = (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {PANEL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setPanelTab(t.key)}
            className={`rounded px-2 py-1 text-xs font-medium shadow-sm ${
              panelTab === t.key
                ? "bg-green-600 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {estimatorPanel}
    <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-2">
      <p className="text-xs font-medium text-gray-700">Line items</p>
      {stripLines}
      {totalsRows}
      {!editable && (
        <p className="rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          Only draft estimates accept edits — pricing areas will not be saved.
          Use Revise on the estimate document first.
        </p>
      )}
      <Link
        href={`/estimates/${estimate.id}`}
        className="flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-blue-700 shadow-sm hover:bg-gray-50"
      >
        <FileText className="h-3.5 w-3.5" />
        Open the estimate document
      </Link>
    </div>
      {/* Measurement accuracy, footnoted under everything it applies to:
          areas, plants and labor all derive from the same satellite imagery.

          It lives HERE rather than in LawnMeasurementMap because this section
          is injected into the map's own floating panel through `panelSlot`, so
          it renders in the right place without editing a 949-line component
          that another lane is actively changing.

          Slope is the one worth stating plainly: the math is planar
          (areaSqftFromPoints, lengthFtFromPoints), so sloped ground always
          measures LOW — an error in one direction, which a pro can pad for
          only if they know about it. */}
      <p className="px-1 text-[11px] leading-snug text-gray-500">
        Measured from satellite imagery — expect a few feet of variance. Slope
        is not included, so sloped ground measures low.
      </p>
    </div>
  );

  return (
    // Full-viewport shell: the page never scrolls — h-dvh (not h-screen, which
    // overshoots under mobile browser chrome), overflow hidden, and only the
    // map's panel scrolls internally. z-[60] sits over the mobile BottomNav
    // (z-50) so the canvas owns the whole phone; the desktop Sidebar (z-30)
    // stays visible via lg:left-64, matching Providers' lg:pl-64 offset.
    <div className="fixed inset-x-0 top-0 z-[60] h-dvh overflow-hidden bg-gray-50 lg:left-64">
      <div className="relative h-full w-full">
        <LawnMeasurementMap
          estimateId={estimate.id}
          address={address}
          onAddLineItem={addMeasuredLine}
          onAreasChange={setAreas}
          panelSlot={lineItemsSection}
          panelBadge={
            <span className="whitespace-nowrap text-xs font-semibold text-green-700">
              {items.length} {items.length === 1 ? "item" : "items"} ·{" "}
              {formatMoney(totals.grandTotal)}
            </span>
          }
        />

        {/* Compact bar floating OVER the canvas — back, title, save state.
            Auto-width (it must not block map taps on a phone); on desktop it
            sits top-right, clear of the docked panel. */}
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 flex justify-end lg:inset-x-auto lg:right-3 lg:top-3">
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-gray-200 bg-white/95 px-2 py-1.5 shadow-sm backdrop-blur lg:px-3">
            {/* Below sm the label is hidden, so without padding the whole tap
                target was the 16px icon — you had to hit a box the size of the
                arrow itself. -m-1.5 keeps the bar's height unchanged while the
                hit area grows past 40px. */}
            <Link
              href={`/estimates/${estimate.id}`}
              aria-label="Back to the estimate"
              className="-m-1.5 flex shrink-0 items-center gap-1 rounded p-1.5 text-sm text-blue-600 hover:bg-blue-50 active:bg-blue-100"
            >
              <ArrowLeft className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Back</span>
            </Link>
            {/* The property, not the word "Estimate". `title` is usually empty,
                so this read "Estimate  Estimate" beside the back link — the
                same word twice, naming nothing. The customer or property is
                what tells you which job you are measuring. */}
            <h1 className="min-w-0 flex-1 truncate text-sm font-bold text-gray-900">
              {estimate.title ||
                estimate.customers?.name ||
                estimate.jobs?.name ||
                address ||
                "Untitled estimate"}
            </h1>
            {persisting && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gray-400" />
            )}
            <span className="shrink-0">
              <StatusBadge
                tone={ESTIMATE_STATUS_TONE[estimate.status as EstimateStatus] ?? "neutral"}
                size="sm"
              >
                {ESTIMATE_STATUS_LABEL[estimate.status as EstimateStatus] ?? estimate.status}
              </StatusBadge>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}