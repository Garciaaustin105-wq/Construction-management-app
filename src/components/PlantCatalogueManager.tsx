"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { Loader2, Pencil, Plus, Trash2, Trees, X } from "lucide-react";
import { AREA_COLORS } from "@/lib/estimateAreas";
import { formatMoney } from "@/lib/money";
import {
  PLANT_CATEGORIES,
  createPlantProduct,
  deactivatePlantProduct,
  updatePlantProduct,
  type PlantCategory,
  type PlantProduct,
} from "@/lib/plantProducts";

// The org's plant & tree catalog (lawn estimator phase 2). Office/PM CRUD
// straight through RLS (`plant_product_office_all` = tier_office_or_pm) via the
// plantProducts contract — no inline catalogue queries, no re-derived math.
//
// WHY DEACTIVATE RATHER THAN DELETE (surfaced in the UI, not just here): a
// placed plant snapshots its own name / size / price into the estimate at drop
// time, so deleting a product never corrupts history. But the catalog is the
// record of what the org sells, and a deleted row can't be placed again.
// Inactive plants stay visible (dimmed) and are simply withheld from the map's
// plant picker. Delete is kept for genuine mistakes — typos entered five
// seconds ago — and warns accordingly.

type Draft = {
  name: string;
  category: PlantCategory;
  size: string;
  unit_price: number;
  color: string;
  notes: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: "",
  // Shrubs are the most common catalogue entry and the readPlantSnapshot
  // fallback, so the form starts there.
  category: "shrub",
  size: "",
  unit_price: 0,
  color: AREA_COLORS[0],
  notes: "",
  active: true,
};

function toDraft(p: PlantProduct): Draft {
  return {
    name: p.name,
    category: p.category,
    size: p.size ?? "",
    // NumberInput treats 0 as "empty", which reads as "price not set yet".
    unit_price: p.unit_price ?? 0,
    color: p.color || AREA_COLORS[0],
    notes: p.notes ?? "",
    active: p.active,
  };
}

export default function PlantCatalogueManager({
  initial,
  orgId,
}: {
  initial: PlantProduct[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [products, setProducts] = useState<PlantProduct[]>(initial);
  const [editing, setEditing] = useState<PlantProduct | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Active first (matches the chemical catalog), then trees above shrubs —
  // PLANT_CATEGORIES is in planting-plan order, the same index buildPlantLegend
  // sorts by, so a legend and this list read the same way: canopy down to
  // groundcover, name within category.
  const sorted = useMemo(() => {
    const order = new Map<string, number>(
      PLANT_CATEGORIES.map((c, i) => [c, i])
    );
    return [...products].sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) ||
        a.name.localeCompare(b.name)
    );
  }, [products]);

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function openEdit(p: PlantProduct) {
    setEditing(p);
    setDraft(toDraft(p));
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      toast.warning("Plant name is required");
      return;
    }

    // Blank size/notes → null so they read as "not recorded" rather than
    // present-but-empty. unit_price stays a number (0 = free/unset — the
    // catalogue is the quick estimator's price source, so it is never nulled).
    const payload = {
      name,
      category: draft.category,
      size: draft.size.trim() || null,
      unit_price: draft.unit_price,
      color: draft.color,
      notes: draft.notes.trim() || null,
      active: draft.active,
    };

    setSaving(true);
    if (editing) {
      const error = await updatePlantProduct(supabase, editing.id, payload);
      setSaving(false);
      if (error) {
        toast.error(error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) => (p.id === editing.id ? { ...p, ...payload } : p))
      );
      toast.success("Plant updated");
    } else {
      const { data, error } = await createPlantProduct(supabase, {
        organization_id: orgId,
        ...payload,
      });
      setSaving(false);
      if (error || !data) {
        toast.error(error ?? "Could not add plant");
        return;
      }
      setProducts((prev) => [data, ...prev]);
      toast.success("Plant added");
    }
    closeForm();
  }

  async function toggleActive(p: PlantProduct) {
    setBusyId(p.id);
    const next = !p.active;
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const error = next
      ? await updatePlantProduct(supabase, p.id, { active: true })
      : await deactivatePlantProduct(supabase, p.id);
    setBusyId(null);
    if (error) {
      setProducts((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, active: p.active } : x))
      );
      toast.error(error);
    }
  }

  async function remove(p: PlantProduct) {
    if (
      !confirm(
        `Delete "${p.name}"?\n\nPlaced plants keep their own snapshot of name, ` +
          `size and price, so past estimates stay intact — but this row can ` +
          `never be placed again, and the catalog is your record of what you ` +
          `sell. If you've stopped carrying it, deactivate it instead.`
      )
    ) {
      return;
    }
    setBusyId(p.id);
    // The contract deliberately ships deactivate-only; this one hard delete for
    // typos is the same inline op the chemical catalog uses.
    const { error } = await supabase
      .from("plant_products")
      .delete()
      .eq("id", p.id);
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setProducts((prev) => prev.filter((x) => x.id !== p.id));
    toast.success("Plant deleted");
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {products.length} plant{products.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add plant
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-10 space-y-3">
          <p className="text-sm text-gray-500">
            Your plant &amp; tree catalog is empty. Add the plants you sell —
            with size and installed price — so they can be dropped and priced on
            an estimate map.
          </p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first plant
          </button>
        </div>
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <ul className="space-y-2 lg:hidden">
            {sorted.map((p) => (
              <li
                key={p.id}
                className={`bg-white rounded-lg p-3 shadow-sm ${p.active ? "" : "opacity-60"}`}
              >
                <div className="flex items-start gap-2">
                  <Trees className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
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
                    {p.size && (
                      <p className="text-xs text-gray-500 truncate">{p.size}</p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                      <span className="capitalize">{p.category}</span>
                      <span className="tabular-nums">
                        {formatMoney(p.unit_price)} / plant
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
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
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden lg:block bg-white rounded-lg shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr className="text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 font-medium">Plant</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium text-right">
                    Price / plant
                  </th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((p) => (
                  <tr key={p.id} className={p.active ? "" : "opacity-55"}>
                    <td className="px-3 py-2 font-medium text-gray-900">
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
                    </td>
                    <td className="px-3 py-2 text-gray-600 capitalize">
                      {p.category}
                    </td>
                    <td className="px-3 py-2 text-gray-600">{p.size ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                      {formatMoney(p.unit_price)}
                    </td>
                    <td className="px-3 py-2 text-gray-500 max-w-[220px] truncate">
                      {p.notes ?? ""}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-3">
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
                        <button
                          onClick={() => remove(p)}
                          disabled={busyId === p.id}
                          className="text-gray-300 hover:text-red-600 disabled:opacity-50"
                          aria-label={`Delete ${p.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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
            aria-label={editing ? `Edit ${editing.name}` : "Add plant"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit plant" : "Add plant"}
              </h2>
              <button
                onClick={closeForm}
                aria-label="Close"
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            <form onSubmit={save} className="p-4 space-y-3">
              <input
                autoFocus
                className={field}
                placeholder="Plant or tree name *"
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
                      category: e.target.value as PlantCategory,
                    })
                  }
                >
                  {PLANT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <input
                className={field}
                placeholder="Size (30 gal, #5, 2in cal, B&B)"
                value={draft.size}
                onChange={(e) => setDraft({ ...draft, size: e.target.value })}
              />

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Installed price per plant ($)
                </span>
                <NumberInput
                  value={draft.unit_price}
                  onChange={(n) => setDraft({ ...draft, unit_price: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  What the customer pays per plant, installed. One number, not
                  material + labor.
                </span>
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
                  Swatch shown on the map and in the planting-plan legend.
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
                Active (available when placing plants on an estimate)
              </label>

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Add plant"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}