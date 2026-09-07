"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import DataTable from "@/components/ui/DataTable";
import {
  ChevronDown,
  ChevronUp,
  Droplets,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { AREA_COLORS } from "@/lib/estimateAreas";
import { formatMoney } from "@/lib/money";
import {
  HEAD_CATEGORIES,
  createIrrigationNozzle,
  createIrrigationProduct,
  deleteIrrigationNozzle,
  describeThrow,
  sortNozzles,
  updateIrrigationNozzle,
  updateIrrigationProduct,
  type HeadCategory,
  type IrrigationNozzle,
  type IrrigationProduct,
  type IrrigationWithNozzles,
} from "@/lib/irrigationProducts";

// The org's sprinkler-head catalogue (Lane A). Office/PM CRUD straight through
// RLS via the irrigationProducts contract — no inline catalogue queries, no
// re-derived math.
//
// MODELS AND NOZZLES ARE DIFFERENT ROWS, exactly like a plant species and its
// sizes: a head MODEL is the part ("Hunter PGP rotor") and a NOZZLE is what
// you buy and install at a radius and price. One model expands to its
// nozzles; one model open at a time.
//
// THE ONE FIELD THIS SCREEN EXISTS TO GET RIGHT is the nozzle's throw. The
// manufacturer chart calls it "radius" and it is measured FROM THE HEAD —
// a 30 ft head wets a circle 60 ft ACROSS. Entering the diameter draws twice
// the real coverage and nothing downstream can detect it, so the input is
// labelled "Throw from the head (ft)" and renders describeThrow() live while
// typing: both numbers on screen at the moment of entry. radius_ft 0 means
// NOT RECORDED — it renders as unset ("—"), never as "0 ft", and draws no
// coverage. The seeded catalogue ships 54 nozzles in exactly that state.
//
// WHY DEACTIVATE RATHER THAN DELETE (surfaced in the UI, not just here): a
// placed head snapshots its own name / nozzle / price into the estimate at
// drop time, so deleting a model never corrupts history. But a deleted row
// can't be placed again, and the catalogue is the record of what the org
// installs. Inactive models stay visible (dimmed) and are withheld from the
// map's head picker. The contract deliberately ships deactivate-only for
// models; nozzles get a real deleteIrrigationNozzle for typos.

type Draft = {
  name: string;
  category: HeadCategory;
  color: string;
  notes: string;
  active: boolean;
};

type NozzleDraft = {
  nozzle: string;
  radius_ft: number;
  // A throw distance is only true AT a pressure. 0 means not recorded, and for
  // min_psi that is meaningful: no minimum recorded means the below-minimum
  // refusal cannot fire, which is better than firing at a guessed threshold.
  rated_psi: number;
  min_psi: number;
  cost: number;
  unit_price: number;
  install_minutes: number;
};

const EMPTY: Draft = {
  name: "",
  // Rotors are the most common head in a turf system and the readHeadSnapshot
  // fallback category is "other" — the form starts where the work is.
  category: "rotor",
  color: AREA_COLORS[0],
  notes: "",
  active: true,
};

const EMPTY_NOZZLE: NozzleDraft = {
  nozzle: "",
  radius_ft: 0,
  rated_psi: 0,
  min_psi: 0,
  cost: 0,
  unit_price: 0,
  install_minutes: 0,
};

function toDraft(p: IrrigationProduct): Draft {
  return {
    name: p.name,
    category: p.category,
    color: p.color || AREA_COLORS[0],
    notes: p.notes ?? "",
    active: p.active,
  };
}

// `3 nozzles · $8–$14` — the collapsed row's summary. A model with no
// nozzles says so: it can't be placed or priced until it has one.
function nozzleSummary(p: IrrigationWithNozzles): string {
  if (p.nozzles.length === 0) return "No nozzles yet";
  const prices = p.nozzles.map((n) => n.unit_price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range =
    min === max
      ? formatMoney(min)
      : `${formatMoney(min)}–${formatMoney(max)}`;
  return `${p.nozzles.length} nozzle${p.nozzles.length === 1 ? "" : "s"} · ${range}`;
}

export default function IrrigationProductsManager({
  initial,
  orgId,
}: {
  initial: IrrigationWithNozzles[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [products, setProducts] = useState<IrrigationWithNozzles[]>(initial);
  const [editing, setEditing] = useState<IrrigationProduct | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The nozzle editor: exactly one model expanded at a time.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nozzleEditing, setNozzleEditing] = useState<IrrigationNozzle | null>(null);
  const [nozzleDraft, setNozzleDraft] = useState<NozzleDraft>(EMPTY_NOZZLE);
  const [showNozzleForm, setShowNozzleForm] = useState(false);
  const [savingNozzle, setSavingNozzle] = useState(false);
  const [nozzleBusyId, setNozzleBusyId] = useState<string | null>(null);

  // Active first (matches the plant and chemical catalogues), then name —
  // listIrrigationCatalogue already orders by name and sortNozzles keeps the
  // nozzle order inside each model.
  const sorted = useMemo(
    () =>
      [...products].sort(
        (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
      ),
    [products]
  );

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function openEdit(p: IrrigationProduct) {
    setEditing(p);
    setDraft(toDraft(p));
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  function openNozzles(p: IrrigationWithNozzles) {
    setExpanded(expanded === p.id ? null : p.id);
    closeNozzleForm();
  }

  function openNozzleAdd() {
    setNozzleEditing(null);
    setNozzleDraft(EMPTY_NOZZLE);
    setShowNozzleForm(true);
  }

  function openNozzleEdit(n: IrrigationNozzle) {
    setNozzleEditing(n);
    setNozzleDraft({
      nozzle: n.nozzle,
      radius_ft: Number(n.radius_ft ?? 0),
      rated_psi: Number(n.rated_psi ?? 0),
      min_psi: Number(n.min_psi ?? 0),
      cost: Number(n.cost ?? 0),
      unit_price: Number(n.unit_price ?? 0),
      install_minutes: Number(n.install_minutes ?? 0),
    });
    setShowNozzleForm(true);
  }

  function closeNozzleForm() {
    setShowNozzleForm(false);
    setNozzleEditing(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      toast.warning("Model name is required");
      return;
    }

    // A head MODEL carries no price — prices live on nozzles, exactly as a
    // plant species carries none and its sizes do.
    const payload = {
      name,
      category: draft.category,
      color: draft.color,
      notes: draft.notes.trim() || null,
    };

    setSaving(true);
    if (editing) {
      const error = await updateIrrigationProduct(supabase, editing.id, {
        ...payload,
        active: draft.active,
      });
      setSaving(false);
      if (error) {
        toast.error(error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === editing.id ? { ...p, ...payload, active: draft.active } : p
        )
      );
      toast.success("Model updated");
    } else {
      // New models ship active — the DB column defaults to true and the form
      // only offers the toggle on edit.
      const { data, error } = await createIrrigationProduct(supabase, {
        organization_id: orgId,
        ...payload,
      });
      setSaving(false);
      if (error || !data) {
        toast.error(error ?? "Could not add head model");
        return;
      }
      setProducts((prev) => [{ ...data, nozzles: [] }, ...prev]);
      toast.success("Model added");
    }
    closeForm();
  }

  async function toggleActive(p: IrrigationWithNozzles) {
    setBusyId(p.id);
    const next = !p.active;
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const error = await updateIrrigationProduct(supabase, p.id, { active: next });
    setBusyId(null);
    if (error) {
      setProducts((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, active: p.active } : x))
      );
      toast.error(error);
    }
  }

  async function saveNozzle(e: React.FormEvent, productId: string) {
    e.preventDefault();
    const nozzle = nozzleDraft.nozzle.trim();
    if (!nozzle) {
      toast.warning("Nozzle label is required");
      return;
    }
    const payload = {
      nozzle,
      radius_ft: nozzleDraft.radius_ft,
      // null rather than 0 when blank: the columns are nullable, and null reads
      // as "not recorded" everywhere downstream while 0 would read as a real
      // pressure of zero.
      rated_psi: nozzleDraft.rated_psi > 0 ? nozzleDraft.rated_psi : null,
      min_psi: nozzleDraft.min_psi > 0 ? nozzleDraft.min_psi : null,
      cost: nozzleDraft.cost,
      unit_price: nozzleDraft.unit_price,
      install_minutes: nozzleDraft.install_minutes,
    };
    setSavingNozzle(true);
    if (nozzleEditing) {
      const error = await updateIrrigationNozzle(supabase, nozzleEditing.id, payload);
      setSavingNozzle(false);
      if (error) {
        toast.error(error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId
            ? {
                ...p,
                nozzles: sortNozzles(
                  p.nozzles.map((n) =>
                    n.id === nozzleEditing.id ? { ...n, ...payload } : n
                  )
                ),
              }
            : p
        )
      );
      toast.success("Nozzle updated");
    } else {
      // sort_order is never typed — it IS the position in the nozzle tree,
      // and the order is never alphabetical ("15-VAN" would sort before
      // "3.0"). A new nozzle lands after the last one.
      const parent = products.find((p) => p.id === productId);
      const nextOrder =
        parent && parent.nozzles.length > 0
          ? Math.max(...parent.nozzles.map((n) => n.sort_order)) + 1
          : 0;
      const { data, error } = await createIrrigationNozzle(supabase, {
        organization_id: orgId,
        irrigation_product_id: productId,
        ...payload,
        sort_order: nextOrder,
      });
      setSavingNozzle(false);
      if (error || !data) {
        toast.error(error ?? "Could not add nozzle");
        return;
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, nozzles: sortNozzles([...p.nozzles, data]) } : p
        )
      );
      toast.success("Nozzle added");
    }
    closeNozzleForm();
  }

  async function removeNozzle(productId: string, n: IrrigationNozzle) {
    if (
      !confirm(
        `Delete nozzle "${n.nozzle}"?\n\nPlaced heads keep their own snapshot ` +
          `of model, nozzle and price, so past estimates stay intact — but ` +
          `this nozzle can no longer be placed.`
      )
    ) {
      return;
    }
    setNozzleBusyId(n.id);
    const error = await deleteIrrigationNozzle(supabase, n.id);
    setNozzleBusyId(null);
    if (error) {
      toast.error(error);
      return;
    }
    setProducts((prev) =>
      prev.map((p) =>
        p.id === productId
          ? { ...p, nozzles: p.nozzles.filter((x) => x.id !== n.id) }
          : p
      )
    );
    toast.success("Nozzle deleted");
  }

  // The expanded model's nozzle editor — written once, rendered inside the
  // desktop rowExpansion and inside the mobile card.
  function nozzlesBlock(p: IrrigationWithNozzles) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5 space-y-2">
        {p.nozzles.length === 0 ? (
          <p className="text-[11px] font-medium text-amber-700">
            No nozzles yet — this model can&apos;t be placed on a map or priced
            until it has one.
          </p>
        ) : (
          p.nozzles.map((n) => (
            <div key={n.id} className="flex items-start gap-2 text-xs">
              <span className="font-semibold text-gray-900 min-w-[64px]">
                {n.nozzle}
              </span>
              <div className="flex-1 min-w-0 flex flex-wrap gap-x-3 gap-y-0.5 text-gray-500 tabular-nums">
                <span>{describeThrow(Number(n.radius_ft ?? 0))}</span>
                <span>cost {formatMoney(Number(n.cost ?? 0))}</span>
                <span>{formatMoney(Number(n.unit_price ?? 0))} installed</span>
                {/* 0 = not estimated, not free. */}
                <span>
                  {Number(n.install_minutes ?? 0) > 0
                    ? `${n.install_minutes} man-min`
                    : "—"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => openNozzleEdit(n)}
                  className="text-gray-400 hover:text-gray-700"
                  aria-label={`Edit nozzle ${n.nozzle}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => removeNozzle(p.id, n)}
                  disabled={nozzleBusyId === n.id}
                  className="text-gray-300 hover:text-red-600 disabled:opacity-50"
                  aria-label={`Delete nozzle ${n.nozzle}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}

        {showNozzleForm && (
          <form
            onSubmit={(e) => saveNozzle(e, p.id)}
            className="border-t border-gray-200 pt-2 space-y-2"
          >
            <input
              autoFocus
              className={field}
              placeholder="Nozzle label (3.0, 15-VAN, MP3000) *"
              value={nozzleDraft.nozzle}
              onChange={(e) =>
                setNozzleDraft({ ...nozzleDraft, nozzle: e.target.value })
              }
            />
            <label className="block">
              <span className="text-xs font-medium text-gray-600">
                Throw from the head (ft)
              </span>
              <NumberInput
                value={nozzleDraft.radius_ft}
                onChange={(n) =>
                  setNozzleDraft({ ...nozzleDraft, radius_ft: n })
                }
                placeholder="0"
                className={`${field} mt-1`}
              />
              {/* Both numbers at the moment of entry — the entire defence
                  against someone entering the diameter, which no validation
                  can catch because 30 and 60 are both plausible throws. */}
              <span
                className={`mt-1 block text-[11px] ${
                  nozzleDraft.radius_ft > 0 ? "text-gray-400" : "text-amber-700"
                }`}
              >
                {describeThrow(nozzleDraft.radius_ft)}
              </span>
            </label>

            {/* THE PRESSURE PAIR. A throw distance is only true AT a pressure,
                and without these two the app has to treat the radius as valid
                everywhere.

                min_psi is the one that matters most: below it a rotor stops
                rotating and a spray breaks into mist, so adjustedRadius()
                REFUSES to return a distance rather than quoting a shorter one.
                Leave it blank if the manufacturer does not publish it — a
                guessed minimum makes that refusal fire at the wrong threshold,
                which is worse than it not firing. */}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Rated at (psi)
                </span>
                <NumberInput
                  value={nozzleDraft.rated_psi}
                  onChange={(n) =>
                    setNozzleDraft({ ...nozzleDraft, rated_psi: n })
                  }
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  The pressure the throw above was measured at. Usually on the
                  same chart.
                </span>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Minimum (psi)
                </span>
                <NumberInput
                  value={nozzleDraft.min_psi}
                  onChange={(n) =>
                    setNozzleDraft({ ...nozzleDraft, min_psi: n })
                  }
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  Below this the nozzle stops working properly. Blank if the
                  chart does not say.
                </span>
              </label>
            </div>
            {nozzleDraft.radius_ft > 0 && nozzleDraft.rated_psi <= 0 && (
              <p className="rounded bg-amber-100 p-2 text-[11px] text-amber-800">
                Without a rated pressure this throw is treated as correct at
                every pressure. Record it and a site running low gets an honest
                figure instead.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Cost ($)
                </span>
                <NumberInput
                  value={nozzleDraft.cost}
                  onChange={(n) => setNozzleDraft({ ...nozzleDraft, cost: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Price ($)
                </span>
                <NumberInput
                  value={nozzleDraft.unit_price}
                  onChange={(n) =>
                    setNozzleDraft({ ...nozzleDraft, unit_price: n })
                  }
                  placeholder="0"
                  className={`${field} mt-1`}
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">
                Install time (man-minutes)
              </span>
              <NumberInput
                value={nozzleDraft.install_minutes}
                onChange={(n) =>
                  setNozzleDraft({ ...nozzleDraft, install_minutes: n })
                }
                placeholder="0"
                className={`${field} mt-1`}
              />
              <span className="mt-1 block text-[11px] text-gray-400">
                Leave 0 if not estimated — it never quotes labor as free.
              </span>
            </label>
            <button
              type="submit"
              disabled={savingNozzle}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800 disabled:opacity-50"
            >
              {savingNozzle && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {nozzleEditing ? "Save nozzle" : "Add nozzle"}
            </button>
          </form>
        )}

        {!showNozzleForm && (
          <button
            onClick={openNozzleAdd}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-gray-300 rounded-lg px-2.5 py-1.5 active:bg-gray-100"
          >
            <Plus className="h-3.5 w-3.5" />
            Add nozzle
          </button>
        )}
      </div>
    );
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {products.length} head model{products.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add model
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-10 space-y-3">
          <p className="text-sm text-gray-500">
            Your sprinkler-head catalog is empty. Add the head models you
            install, then give each one its nozzles — the throw, cost and
            installed price live on the nozzle.
          </p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first model
          </button>
        </div>
      ) : (
        <DataTable
          columns={[
            {
              key: "name",
              header: "Model",
              cell: (p) => (
                <span className="font-medium text-gray-900">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full border border-black/10 align-middle"
                    style={{ backgroundColor: p.color }}
                  />
                  {p.name}
                  {!p.active && (
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      (inactive)
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "category",
              header: "Category",
              cell: (p) => (
                <span className="text-gray-600 capitalize">{p.category}</span>
              ),
              hideOnMobile: true,
            },
            {
              key: "nozzles",
              header: "Nozzles",
              cell: (p) => (
                <span
                  className={
                    p.nozzles.length === 0
                      ? "font-medium text-amber-700"
                      : "text-gray-600"
                  }
                >
                  {nozzleSummary(p)}
                </span>
              ),
            },
            {
              key: "notes",
              header: "Notes",
              cell: (p) => (
                <span className="text-gray-500 truncate block max-w-56">
                  {p.notes ?? ""}
                </span>
              ),
              hideOnMobile: true,
            },
            {
              key: "actions",
              header: "",
              align: "right",
              cell: (p) => (
                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={() => openNozzles(p)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={
                      expanded === p.id
                        ? `Hide nozzles for ${p.name}`
                        : `Show nozzles for ${p.name}`
                    }
                  >
                    {expanded === p.id ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => toggleActive(p)}
                    disabled={busyId === p.id}
                    className="text-xs text-slate-600 hover:underline disabled:opacity-50"
                  >
                    {p.active ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    onClick={() => openEdit(p)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={`Edit ${p.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              ),
            },
          ]}
          rows={sorted}
          framed
          rowExpansion={(p) => (expanded === p.id ? nozzlesBlock(p) : null)}
          mobileCardBare
          mobileCardClassName={(p) =>
            `bg-white rounded-lg p-3 shadow-sm ${p.active ? "" : "opacity-60"}`
          }
          mobileCard={(p) => (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Droplets className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    <span
                      className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full border border-black/10 align-middle"
                      style={{ backgroundColor: p.color }}
                    />
                    {p.name}
                    {!p.active && (
                      <span className="ml-2 text-[11px] font-normal text-gray-500">
                        (inactive)
                      </span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                    <span className="capitalize">{p.category}</span>
                    <span
                      className={
                        p.nozzles.length === 0
                          ? "font-medium text-amber-700"
                          : ""
                      }
                    >
                      {nozzleSummary(p)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    onClick={() => openNozzles(p)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={
                      expanded === p.id
                        ? `Hide nozzles for ${p.name}`
                        : `Show nozzles for ${p.name}`
                    }
                  >
                    {expanded === p.id ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => openEdit(p)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={`Edit ${p.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => toggleActive(p)}
                    disabled={busyId === p.id}
                    className="text-[11px] text-slate-600 hover:underline disabled:opacity-50"
                  >
                    {p.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
              {expanded === p.id && nozzlesBlock(p)}
            </div>
          )}
        />
      )}

      {/* Add / edit drawer */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-black/40"
            onClick={closeForm}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={editing ? `Edit ${editing.name}` : "Add head model"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit head model" : "Add head model"}
              </h2>
              <button
                onClick={closeForm}
                aria-label="Close"
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            {/* pb-24: the fixed mobile BottomNav overlays the bottom of this
                drawer — without clearance the submit button can never scroll
                above it (unreachable on a phone). */}
            <form onSubmit={save} className="p-4 pb-24 space-y-3">
              <input
                autoFocus
                className={field}
                placeholder="Model name (Hunter PGP, Rain Bird 5000) *"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Category
                </span>
                <select
                  className={`${field} mt-1`}
                  value={draft.category}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      category: e.target.value as HeadCategory,
                    })
                  }
                >
                  {HEAD_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <div>
                <span className="text-xs font-medium text-gray-600">
                  Legend colour
                </span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {AREA_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Colour ${c}`}
                      onClick={() => setDraft({ ...draft, color: c })}
                      className={`h-7 w-7 rounded-full border ${
                        draft.color === c
                          ? "ring-2 ring-gray-900 ring-offset-1 border-transparent"
                          : "border-gray-300"
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <span className="mt-1 block text-[11px] text-gray-400">
                  Swatch shown on the map and in the head legend.
                </span>
              </div>

              <textarea
                className={field}
                rows={3}
                placeholder="Notes"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) =>
                    setDraft({ ...draft, active: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                Active (available when placing heads on an estimate)
              </label>

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Add model"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}