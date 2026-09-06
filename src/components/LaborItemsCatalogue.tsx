"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import DataTable from "@/components/ui/DataTable";
import {
  Beaker,
  Loader2,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import {
  LABOR_CATEGORIES,
  LABOR_UNITS,
  LABOR_SCOPE_NOTE,
  benchmarkFor,
  describeBenchmark,
  unitLabel,
  createLaborItem,
  updateLaborItem,
  type LaborItem,
  type LaborCategory,
  type LaborUnit,
} from "@/lib/laborItems";

type Draft = {
  name: string;
  category: LaborCategory;
  unit: LaborUnit;
  cost: number;
  unit_price: number;
  install_minutes: number;
  notes: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: "",
  category: LABOR_CATEGORIES[0],
  unit: LABOR_UNITS[0],
  cost: 0,
  unit_price: 0,
  install_minutes: 0,
  notes: "",
  active: true,
};

function toDraft(p: LaborItem): Draft {
  return {
    name: p.name,
    category: p.category,
    unit: p.unit,
    cost: p.cost,
    unit_price: p.unit_price,
    install_minutes: p.install_minutes,
    notes: p.notes ?? "",
    active: p.active,
  };
}

const fmtMoney = (n: number) => `$${n.toFixed(2)}`;

export default function LaborItemsCatalogue({
  initial,
  orgId,
}: {
  initial: LaborItem[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [items, setItems] = useState<LaborItem[]>(initial);
  const [editing, setEditing] = useState<LaborItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
      ),
    [items]
  );

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function openEdit(p: LaborItem) {
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
      toast.warning("Item name is required");
      return;
    }

    const payload = {
      name,
      category: draft.category,
      unit: draft.unit,
      cost: draft.cost,
      unit_price: draft.unit_price,
      install_minutes: draft.install_minutes,
      active: draft.active,
      notes: draft.notes.trim() || null,
    };

    setSaving(true);
    if (editing) {
      // The contract returns the error message itself, not an error object.
      const error = await updateLaborItem(supabase, editing.id, payload);
      setSaving(false);
      if (error) {
        toast.error(error);
        return;
      }
      setItems((prev) =>
        prev.map((p) => (p.id === editing.id ? { ...p, ...payload } : p))
      );
      toast.success("Item updated");
    } else {
      const { data, error } = await createLaborItem(supabase, {
        organization_id: orgId,
        ...payload,
      });
      setSaving(false);
      if (error || !data) {
        toast.error(error ?? "Could not add item");
        return;
      }
      setItems((prev) => [data, ...prev]);
      toast.success("Item added");
    }
    closeForm();
  }

  async function toggleActive(p: LaborItem) {
    setBusyId(p.id);
    const next = !p.active;
    setItems((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const error = await updateLaborItem(supabase, p.id, { active: next });
    setBusyId(null);
    if (error) {
      setItems((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, active: p.active } : x))
      );
      toast.error(error);
    }
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-3">
      <p className="bg-amber-100 text-amber-700 text-xs p-2 rounded">
        {LABOR_SCOPE_NOTE}
      </p>

      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {items.length} item{items.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add item
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          No labor items yet. Add the labor you offer so they can be quoted
          against a job.
        </p>
      ) : (
        <DataTable
          columns={[
            {
              key: "name",
              header: "Item",
              cell: (p) => (
                <span className="font-medium text-gray-900">
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
              cell: (p) => <span className="text-gray-600">{p.category}</span>,
              hideOnMobile: true,
            },
            {
              key: "unit",
              header: "Unit",
              cell: (p) => <span className="text-gray-600">{p.unit}</span>,
              hideOnMobile: true,
            },
            {
              key: "material",
              header: "Material cost",
              align: "right",
              num: true,
              // 0 is legitimate on a pure-labor row (the contract says so) —
              // it is NOT the same as unpriced and gets no chip. Only the
              // customer-facing unit_price gets the unpriced flag.
              cell: (p) => <span className="text-gray-600">{fmtMoney(p.cost)}</span>,
              hideOnMobile: true,
            },
            {
              key: "price",
              header: "Price",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">
                  {fmtMoney(p.unit_price)}
                  {p.unit_price <= 0 && (
                    <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
                      unpriced
                    </span>
                  )}
                </span>
              ),
              hideOnMobile: true,
            },
            {
              key: "manmin",
              header: "Man-min",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">
                  {p.install_minutes}
                  {p.unit !== "hour" && p.install_minutes <= 0 && (
                    <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
                      untimed
                    </span>
                  )}
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
          mobileCardBare
          mobileCardClassName={(p) =>
            `bg-white rounded-lg p-3 shadow-sm ${p.active ? "" : "opacity-60"}`
          }
          mobileCard={(p) => (
            <div className="flex items-start gap-2">
              <Beaker className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {p.name}
                  {!p.active && (
                    <span className="ml-2 text-[11px] font-normal text-gray-500">
                      (inactive)
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 truncate">
                  {p.category} / {p.unit}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                  <span>{fmtMoney(p.cost)} cost</span>
                  <span>
                    {fmtMoney(p.unit_price)}
                    {p.unit_price <= 0 && (
                      <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
                        unpriced
                      </span>
                    )}
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
          )}
        />
      )}

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
            aria-label={editing ? `Edit ${editing.name}` : "Add item"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit item" : "Add item"}
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
                placeholder="Item name *"
                value={draft.name}
                onChange={(e) =>
                  setDraft({ ...draft, name: e.target.value })
                }
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
                      category: e.target.value as LaborCategory,
                    })
                  }
                >
                  {LABOR_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Unit
                </span>
                {/* unitLabel, not the raw slug: "msqft" alone reads as a typo
                    and the msqft trap (typing 5000 instead of 5) is the worst
                    one in this unit set. */}
                <select
                  className={`${field} mt-1`}
                  value={draft.unit}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      unit: e.target.value as LaborUnit,
                    })
                  }
                >
                  {LABOR_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {unitLabel(u)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Material cost
                  </span>
                  <NumberInput
                    value={draft.cost}
                    onChange={(n) => setDraft({ ...draft, cost: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Price
                  </span>
                  <NumberInput
                    value={draft.unit_price}
                    onChange={(n) => setDraft({ ...draft, unit_price: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Man-min per unit
                </span>
                <NumberInput
                  value={draft.install_minutes}
                  onChange={(n) => setDraft({ ...draft, install_minutes: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  Allow fractional minutes (e.g., 0.5).
                </span>
              </label>
              {benchmarkFor(draft.category, draft.unit) && (
                <p className="text-gray-500 text-xs mt-1">
                  Published figure (suggestion only — never a default):{" "}
                  {describeBenchmark(
                    benchmarkFor(draft.category, draft.unit)!
                  )}
                </p>
              )}
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Notes
                </span>
                <textarea
                  className={field}
                  rows={3}
                  placeholder="Notes"
                  value={draft.notes}
                  onChange={(e) =>
                    setDraft({ ...draft, notes: e.target.value })
                  }
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) =>
                    setDraft({ ...draft, active: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                Active (offered when quoting)
              </label>

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Add item"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
