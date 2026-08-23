"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { Beaker, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { RATE_UNITS, type ChemicalProduct } from "@/lib/chemicals";

// The org's chemical product catalog. Office/PM CRUD straight through RLS
// (`chem_product_office_all` = tier_office_or_pm), mirroring CustomersManager —
// there is no server route for product CRUD by design.
//
// WHY DEACTIVATE RATHER THAN DELETE (surfaced in the UI, not just here):
// applications snapshot the product's name / EPA # / active ingredient at log
// time, so deleting a product never corrupts history. But the catalog is the
// only place the office can see what they've used, and a deleted row can't be
// re-selected for a repeat application. Inactive products stay visible (dimmed)
// and are simply withheld from the log form's picker. Delete is kept for
// genuine mistakes — typos entered five seconds ago — and warns accordingly.

type Draft = {
  name: string;
  epa_reg_number: string;
  active_ingredient: string;
  default_rate: number;
  rate_unit: string;
  re_entry_hours: number;
  active: boolean;
  notes: string;
};

const EMPTY: Draft = {
  name: "",
  epa_reg_number: "",
  active_ingredient: "",
  default_rate: 0,
  rate_unit: RATE_UNITS[0],
  re_entry_hours: 0,
  active: true,
  notes: "",
};

function toDraft(p: ChemicalProduct): Draft {
  return {
    name: p.name,
    epa_reg_number: p.epa_reg_number ?? "",
    active_ingredient: p.active_ingredient ?? "",
    // NumberInput treats 0 as "empty", which is the right display for an unset
    // rate and harmless for a real 0 (a zero application rate is meaningless).
    default_rate: p.default_rate ?? 0,
    rate_unit: p.rate_unit ?? RATE_UNITS[0],
    re_entry_hours: p.re_entry_hours ?? 0,
    active: p.active,
    notes: p.notes ?? "",
  };
}

export default function ChemicalProductsManager({
  initial,
  orgId,
}: {
  initial: ChemicalProduct[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [products, setProducts] = useState<ChemicalProduct[]>(initial);
  const [editing, setEditing] = useState<ChemicalProduct | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...products].sort(
        (a, b) =>
          Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)
      ),
    [products]
  );

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function openEdit(p: ChemicalProduct) {
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
      toast.warning("Product name is required");
      return;
    }

    // Empty strings → null so a blank field reads as "not recorded" rather than
    // a present-but-empty value on the compliance sheet. 0 means "unset" for the
    // two numerics (NumberInput's empty state), not a real measured zero.
    const payload = {
      name,
      epa_reg_number: draft.epa_reg_number.trim() || null,
      active_ingredient: draft.active_ingredient.trim() || null,
      default_rate: draft.default_rate || null,
      rate_unit: draft.rate_unit || null,
      re_entry_hours: draft.re_entry_hours || null,
      active: draft.active,
      notes: draft.notes.trim() || null,
    };

    setSaving(true);
    if (editing) {
      const { error } = await supabase
        .from("chemical_products")
        .update(payload)
        .eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      setProducts((prev) =>
        prev.map((p) => (p.id === editing.id ? { ...p, ...payload } : p))
      );
      toast.success("Product updated");
    } else {
      // Root table — nothing stamps organization_id, so the app must send it.
      const { data, error } = await supabase
        .from("chemical_products")
        .insert({ organization_id: orgId, ...payload })
        .select("*")
        .single();
      setSaving(false);
      if (error || !data) {
        toast.error(error?.message ?? "Could not add product");
        return;
      }
      setProducts((prev) => [data as ChemicalProduct, ...prev]);
      toast.success("Product added");
    }
    closeForm();
  }

  async function toggleActive(p: ChemicalProduct) {
    setBusyId(p.id);
    const next = !p.active;
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const { error } = await supabase
      .from("chemical_products")
      .update({ active: next })
      .eq("id", p.id);
    setBusyId(null);
    if (error) {
      setProducts((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, active: p.active } : x))
      );
      toast.error(error.message);
    }
  }

  async function remove(p: ChemicalProduct) {
    if (
      !confirm(
        `Delete "${p.name}"?\n\nPast applications keep their own record of this product, ` +
          `so history stays intact — but you won't be able to pick it again. ` +
          `If you've used it, deactivate it instead.`
      )
    ) {
      return;
    }
    setBusyId(p.id);
    const { error } = await supabase
      .from("chemical_products")
      .delete()
      .eq("id", p.id);
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setProducts((prev) => prev.filter((x) => x.id !== p.id));
    toast.success("Product deleted");
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {products.length} product{products.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add product
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          No products yet. Add the chemicals you apply so they can be logged
          against a job.
        </p>
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
                    {p.active_ingredient && (
                      <p className="text-xs text-gray-500 truncate">
                        {p.active_ingredient}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                      {p.epa_reg_number && <span>EPA {p.epa_reg_number}</span>}
                      {p.default_rate != null && (
                        <span className="tabular-nums">
                          {p.default_rate} {p.rate_unit ?? ""}
                        </span>
                      )}
                      {p.re_entry_hours != null && (
                        <span className="tabular-nums">
                          {p.re_entry_hours}h re-entry
                        </span>
                      )}
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
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">EPA Reg #</th>
                  <th className="px-3 py-2 font-medium">Active ingredient</th>
                  <th className="px-3 py-2 font-medium text-right">Rate</th>
                  <th className="px-3 py-2 font-medium text-right">Re-entry</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((p) => (
                  <tr key={p.id} className={p.active ? "" : "opacity-55"}>
                    <td className="px-3 py-2 font-medium text-gray-900">
                      {p.name}
                      {!p.active && (
                        <span className="ml-2 text-xs font-normal text-gray-500">
                          (inactive)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-600 tabular-nums">
                      {p.epa_reg_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {p.active_ingredient ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                      {p.default_rate != null
                        ? `${p.default_rate} ${p.rate_unit ?? ""}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600 tabular-nums">
                      {p.re_entry_hours != null ? `${p.re_entry_hours}h` : "—"}
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
            aria-label={editing ? `Edit ${editing.name}` : "Add product"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit product" : "Add product"}
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
                placeholder="Product name *"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <input
                className={field}
                placeholder="EPA registration number"
                value={draft.epa_reg_number}
                onChange={(e) =>
                  setDraft({ ...draft, epa_reg_number: e.target.value })
                }
              />
              <input
                className={field}
                placeholder="Active ingredient"
                value={draft.active_ingredient}
                onChange={(e) =>
                  setDraft({ ...draft, active_ingredient: e.target.value })
                }
              />

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Default rate
                  </span>
                  <NumberInput
                    value={draft.default_rate}
                    onChange={(n) => setDraft({ ...draft, default_rate: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Rate unit
                  </span>
                  <select
                    className={`${field} mt-1`}
                    value={draft.rate_unit}
                    onChange={(e) =>
                      setDraft({ ...draft, rate_unit: e.target.value })
                    }
                  >
                    {RATE_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Re-entry interval (hours)
                </span>
                <NumberInput
                  value={draft.re_entry_hours}
                  onChange={(n) => setDraft({ ...draft, re_entry_hours: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  How long people and pets must stay off the treated area. Used
                  to compute the re-entry time on every application.
                </span>
              </label>

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
                Active (available when logging an application)
              </label>

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Add product"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
