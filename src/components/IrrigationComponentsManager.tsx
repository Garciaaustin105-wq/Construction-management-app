"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import DataTable from "@/components/ui/DataTable";
import { CircuitBoard, Loader2, Pencil, Plus, X } from "lucide-react";
import {
  COMPONENT_CATEGORIES,
  COMPONENT_UNITS,
  createComponent,
  updateComponent,
  type ComponentCategory,
  type ComponentUnit,
  type IrrigationComponent,
} from "@/lib/irrigationSystem";

// The org's irrigation component catalogue (Lane D): everything between the
// water source and the heads — POC, backflow, valves, controller, wire,
// mainline, sleeving. Office/PM CRUD straight through RLS via the
// irrigationSystem contract — no inline catalogue queries, no re-derived math.
//
// THE REASON THIS IS A SEPARATE CATALOGUE is the unit column. Heads are
// per-each; wire, mainline and sleeving are per-FOOT, and `unit: "foot"`
// means the quantity IS feet. Every quantity a customer of this catalogue
// sees is labelled with its unit — on the estimator panel's input as well as
// here — because "200" of wire means 200 FEET, not two rolls.
//
// install_minutes is MAN-minutes PER UNIT. On a per-foot component that is
// per FOOT — small and fractional (0.5 man-min/ft of wire is real), which is
// why the input takes decimals. 200 ft at 0.5 man-min/ft is 100 man-minutes.
//
// WHY DEACTIVATE RATHER THAN DELETE (and why there is no delete at all):
// the contract ships create/update only. A placed component snapshots its
// name / unit / price into the estimate at add time, so deactivating never
// corrupts a quote — but a deleted row can't be priced again, and this
// catalogue is the record of what the org installs. Inactive rows stay
// visible (dimmed) and are withheld from the estimator's Parts picker.
//
// BACKFLOW AND RAIN-SENSOR HONESTY: whether a backflow needs a permit, an
// annual test, or a particular install height is LOCAL CODE, and a rain
// sensor is required by statute in some states. This app carries the part
// and its price; the notes field is where the org records what its own
// installer knows about the jurisdiction. The app must never state a code
// requirement as fact, so nothing here asserts one — notes are surfaced as
// text the org wrote or edited, nothing more.

type Draft = {
  name: string;
  category: ComponentCategory;
  unit: ComponentUnit;
  cost: number;
  unit_price: number;
  install_minutes: number;
  notes: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: "",
  // Point of connection is where every system starts; the seeded catalogue
  // opens there too.
  category: "poc",
  unit: "each",
  cost: 0,
  unit_price: 0,
  install_minutes: 0,
  notes: "",
  active: true,
};

function toDraft(p: IrrigationComponent): Draft {
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

export default function IrrigationComponentsManager({
  initial,
  orgId,
}: {
  initial: IrrigationComponent[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [items, setItems] = useState<IrrigationComponent[]>(initial);
  const [editing, setEditing] = useState<IrrigationComponent | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Search / category / active filter, client-side over `sorted` — 73 seeded
  // components across 17 categories render instantly and a server round-trip
  // per keystroke is unwanted. Text matches the name AND the notes, because
  // the org writes its code/permitting knowledge into notes ("RPZ", "permit")
  // and looks a part up by it too. The sort is kept INSIDE the filtered set.
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | ComponentCategory>("all");
  const [showInactive, setShowInactive] = useState(true);

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
      ),
    [items]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (!showInactive && !p.active) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [sorted, query, categoryFilter, showInactive]);

  const filtersActive =
    query.trim() !== "" || categoryFilter !== "all" || !showInactive;

  function clearFilters() {
    setQuery("");
    setCategoryFilter("all");
    setShowInactive(true);
  }

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function openEdit(p: IrrigationComponent) {
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
      toast.warning("Component name is required");
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
      // The contract returns the error message itself, not an error object —
      // never destructure `{ error }` off it.
      const error = await updateComponent(supabase, editing.id, payload);
      setSaving(false);
      if (error) {
        toast.error(error);
        return;
      }
      setItems((prev) =>
        prev.map((p) => (p.id === editing.id ? { ...p, ...payload } : p))
      );
      toast.success("Component updated");
    } else {
      // createComponent selects the row back — the id comes home, so the new
      // row can be edited immediately without a reload.
      const { data, error } = await createComponent(supabase, {
        organization_id: orgId,
        ...payload,
      });
      setSaving(false);
      if (error || !data) {
        toast.error(error ?? "Could not add component");
        return;
      }
      setItems((prev) => [data, ...prev]);
      toast.success("Component added");
    }
    closeForm();
  }

  async function toggleActive(p: IrrigationComponent) {
    setBusyId(p.id);
    const next = !p.active;
    setItems((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const error = await updateComponent(supabase, p.id, { active: next });
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
  const foot = draft.unit === "foot";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {items.length} component{items.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add component
        </button>
      </div>

      {/* Search / category / active filter — client-side, above the list. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search components"
          className={`${field} flex-1 min-w-40`}
          placeholder="Search name or notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter components by category"
          className={`${field} w-44`}
          value={categoryFilter}
          onChange={(e) =>
            setCategoryFilter(e.target.value as "all" | ComponentCategory)
          }
        >
          <option value="all">All categories</option>
          {COMPONENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          Show inactive
        </label>
        {filtersActive && (
          <button
            onClick={clearFilters}
            className="text-xs text-gray-500 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          {items.length === 0
            ? "No components yet. Add the parts between the water source and the heads — controller, valves, backflow, wire — so they can be priced on an estimate."
            : "No components match this search. Clear the filters to see the full catalog."}
        </p>
      ) : (
        <DataTable
          columns={[
            {
              key: "name",
              header: "Component",
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
              cell: (p) => (
                <span className="text-gray-600">
                  {p.unit === "foot" ? "per ft" : "each"}
                </span>
              ),
              hideOnMobile: true,
            },
            {
              key: "material",
              header: "Material cost",
              align: "right",
              num: true,
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
              header: "Man-min / unit",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">
                  {p.install_minutes}
                  {p.install_minutes <= 0 && (
                    <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
                      untimed
                    </span>
                  )}
                </span>
              ),
              hideOnMobile: true,
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
          rows={filtered}
          framed
          mobileCardBare
          mobileCardClassName={(p) =>
            `bg-white rounded-lg p-3 shadow-sm ${p.active ? "" : "opacity-60"}`
          }
          mobileCard={(p) => (
            <div className="flex items-start gap-2">
              <CircuitBoard className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
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
                  {p.category} · {p.unit === "foot" ? "per ft" : "each"}
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
                {p.notes && (
                  <p className="mt-0.5 text-[11px] text-gray-400 truncate">
                    {p.notes}
                  </p>
                )}
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
            aria-label={editing ? `Edit ${editing.name}` : "Add component"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit component" : "Add component"}
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
                placeholder="Component name *"
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
                      category: e.target.value as ComponentCategory,
                    })
                  }
                >
                  {COMPONENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Unit</span>
                {/* The unit IS the trap: `foot` means the quantity IS feet.
                    Label it as what it means, not as a slug. */}
                <select
                  className={`${field} mt-1`}
                  value={draft.unit}
                  onChange={(e) =>
                    setDraft({ ...draft, unit: e.target.value as ComponentUnit })
                  }
                >
                  {COMPONENT_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u === "foot" ? "foot (quantity IS feet — wire, mainline, sleeving)" : "each"}
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
                  <span className="mt-1 block text-[11px] text-gray-400">
                    per {foot ? "foot" : "each"}
                  </span>
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
                  <span className="mt-1 block text-[11px] text-gray-400">
                    per {foot ? "foot" : "each"} — 0 stays unpriced, never free
                  </span>
                </label>
              </div>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Man-min per unit
                </span>
                {/* Decimals are the point: 0.5 man-min/ft of wire is real, and
                    per-foot values add up — 200 ft at 0.5 is 100 man-minutes.
                    No step="1" here (NumberInput is decimal by design). */}
                <NumberInput
                  value={draft.install_minutes}
                  onChange={(n) => setDraft({ ...draft, install_minutes: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  {foot
                    ? "Per FOOT — small values add up: 200 ft at 0.5 man-min/ft is 100 man-minutes."
                    : "Man-minutes to install one piece."}
                </span>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">Notes</span>
                <textarea
                  className={`${field} mt-1`}
                  rows={3}
                  placeholder='e.g. "PVB, typically 12 in above the highest head — check local code and permitting"'
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  Backflow type, height, permits and annual testing are set by
                  LOCAL CODE — write here what your installer knows about the
                  jurisdiction. The app never asserts a code requirement.
                </span>
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
                Active (offered in the estimator&apos;s Parts picker)
              </label>

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Add component"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}