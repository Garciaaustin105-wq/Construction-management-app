"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import DataTable from "@/components/ui/DataTable";
import { Layers, Loader2, Pencil, Plus, X } from "lucide-react";
import {
  GRASS_TYPES,
  describePallet,
  palletSizeUnset,
  createSodProduct,
  updateSodProduct,
  type SodProduct,
  type GrassType,
} from "@/lib/sodProducts";
import { SOD_INSTALL_BENCHMARK, describeBenchmark } from "@/lib/laborItems";

type Draft = {
  name: string;
  grass_type: GrassType;
  sqft_per_pallet: number;
  cost_per_sqft: number;
  price_per_sqft: number;
  install_minutes_per_1000_sqft: number;
  notes: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: "",
  grass_type: GRASS_TYPES[0],
  // NOT pre-filled with 450. The pallet size is the org's own supplier fact and
  // a default here would silently become their order quantity — see the note
  // rendered beside the field.
  sqft_per_pallet: 0,
  cost_per_sqft: 0,
  price_per_sqft: 0,
  install_minutes_per_1000_sqft: 0,
  notes: "",
  active: true,
};

function toDraft(p: SodProduct): Draft {
  return {
    name: p.name,
    grass_type: p.grass_type,
    sqft_per_pallet: p.sqft_per_pallet,
    cost_per_sqft: p.cost_per_sqft,
    price_per_sqft: p.price_per_sqft,
    install_minutes_per_1000_sqft: p.install_minutes_per_1000_sqft,
    notes: p.notes ?? "",
    active: p.active,
  };
}

// Sod is priced per SQUARE FOOT, so the figures are cents — 0.42, not 42. Two
// decimals is the resolution the trade quotes in.
const fmtSqft = (n: number) => `$${n.toFixed(2)}`;
const grassLabel = (g: GrassType) => g.replace(/_/g, " ");

export default function SodCatalogue({
  initial,
  orgId,
}: {
  initial: SodProduct[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [items, setItems] = useState<SodProduct[]>(initial);
  const [editing, setEditing] = useState<SodProduct | null>(null);
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

  // A missing pallet size is not a missing price — it disables the pallet count
  // entirely, so it is worth counting at the top of the screen.
  const missingPallet = useMemo(
    () => items.filter((p) => p.active && palletSizeUnset(p)).length,
    [items]
  );

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function openEdit(p: SodProduct) {
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
      toast.warning("Sod name is required");
      return;
    }

    const payload = {
      name,
      grass_type: draft.grass_type,
      sqft_per_pallet: draft.sqft_per_pallet,
      cost_per_sqft: draft.cost_per_sqft,
      price_per_sqft: draft.price_per_sqft,
      install_minutes_per_1000_sqft: draft.install_minutes_per_1000_sqft,
      active: draft.active,
      notes: draft.notes.trim() || null,
    };

    setSaving(true);
    if (editing) {
      // The contract returns the error message itself, not an error object.
      const error = await updateSodProduct(supabase, editing.id, payload);
      setSaving(false);
      if (error) {
        toast.error(error);
        return;
      }
      setItems((prev) =>
        prev.map((p) => (p.id === editing.id ? { ...p, ...payload } : p))
      );
      toast.success("Sod updated");
    } else {
      const { data, error } = await createSodProduct(supabase, {
        organization_id: orgId,
        ...payload,
      });
      setSaving(false);
      if (error || !data) {
        toast.error(error ?? "Could not add sod");
        return;
      }
      setItems((prev) => [data, ...prev]);
      toast.success("Sod added");
    }
    closeForm();
  }

  async function toggleActive(p: SodProduct) {
    setBusyId(p.id);
    const next = !p.active;
    setItems((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const error = await updateSodProduct(supabase, p.id, { active: next });
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
      {/* Pallet size is the ONE field here that breaks a feature when blank:
          pallets = sqft / sqft_per_pallet, so zero yields no count at all
          rather than a cautious one. Worth its own banner. */}
      {missingPallet > 0 && (
        <p className="bg-amber-100 text-amber-700 text-xs p-2 rounded">
          {missingPallet} active {missingPallet === 1 ? "sod has" : "sods have"}{" "}
          no pallet size, so no pallet count can be worked out for{" "}
          {missingPallet === 1 ? "it" : "them"} — the estimate will price the
          area but cannot say how much to order. Ask your farm what a pallet
          covers; it is commonly 400–500 sq ft and varies by farm.
        </p>
      )}

      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {items.length} sod{items.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add sod
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          No sod yet. Add the varieties you install so they can be quoted
          against a measured area.
        </p>
      ) : (
        <DataTable
          columns={[
            {
              key: "name",
              header: "Sod",
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
              key: "grass",
              header: "Grass",
              cell: (p) => (
                <span className="text-gray-600 capitalize">
                  {grassLabel(p.grass_type)}
                </span>
              ),
              hideOnMobile: true,
            },
            {
              key: "pallet",
              header: "Pallet",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">
                  {p.sqft_per_pallet > 0 ? `${p.sqft_per_pallet} sqft` : "—"}
                  {palletSizeUnset(p) && (
                    <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
                      no pallet count
                    </span>
                  )}
                </span>
              ),
              hideOnMobile: true,
            },
            {
              key: "cost",
              header: "Cost / sqft",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">{fmtSqft(p.cost_per_sqft)}</span>
              ),
              hideOnMobile: true,
            },
            {
              key: "price",
              header: "Price / sqft",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">
                  {fmtSqft(p.price_per_sqft)}
                  {p.price_per_sqft <= 0 && (
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
              header: "Man-min / MSF",
              align: "right",
              num: true,
              cell: (p) => (
                <span className="text-gray-600">
                  {p.install_minutes_per_1000_sqft}
                  {p.install_minutes_per_1000_sqft <= 0 && (
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
              <Layers className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {p.name}
                  {!p.active && (
                    <span className="ml-2 text-[11px] font-normal text-gray-500">
                      (inactive)
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 truncate capitalize">
                  {grassLabel(p.grass_type)}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                  <span>{fmtSqft(p.cost_per_sqft)} cost</span>
                  <span>
                    {fmtSqft(p.price_per_sqft)}
                    {p.price_per_sqft <= 0 && (
                      <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
                        unpriced
                      </span>
                    )}
                  </span>
                  <span>
                    {p.sqft_per_pallet > 0 ? `${p.sqft_per_pallet}/pallet` : ""}
                    {palletSizeUnset(p) && (
                      <span className="bg-amber-200 text-amber-800 text-xs px-1 rounded">
                        no pallet count
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
            aria-label={editing ? `Edit ${editing.name}` : "Add sod"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit sod" : "Add sod"}
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
                placeholder="Sod name * (e.g. Floratam St. Augustine)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Grass type
                </span>
                <select
                  className={`${field} mt-1 capitalize`}
                  value={draft.grass_type}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      grass_type: e.target.value as GrassType,
                    })
                  }
                >
                  {GRASS_TYPES.map((g) => (
                    <option key={g} value={g}>
                      {grassLabel(g)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Square feet per pallet
                </span>
                <NumberInput
                  value={draft.sqft_per_pallet}
                  onChange={(n) => setDraft({ ...draft, sqft_per_pallet: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                {/* describePallet() is the contract's own sentence — it never
                    says "0 sq ft per pallet", because an unrecorded size is a
                    missing answer, not a pallet that holds nothing. */}
                <span className="mt-1 block text-[11px] text-gray-400">
                  {describePallet(draft.sqft_per_pallet)} This drives the order
                  directly: at 4,620 sq ft, 400/pallet is 12 pallets and
                  500/pallet is 10. Ask your farm — it varies by harvest method
                  and is not something to assume.
                </span>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Cost / sqft
                  </span>
                  <NumberInput
                    value={draft.cost_per_sqft}
                    onChange={(n) => setDraft({ ...draft, cost_per_sqft: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-gray-600">
                    Price / sqft
                  </span>
                  <NumberInput
                    value={draft.price_per_sqft}
                    onChange={(n) => setDraft({ ...draft, price_per_sqft: n })}
                    placeholder="0"
                    className={`${field} mt-1`}
                  />
                </label>
              </div>
              <span className="block text-[11px] text-gray-400">
                Per SQUARE FOOT, not per pallet — sod is quoted on the area
                covered plus the cutting allowance. The pallet count is what to
                buy, which is a different number.
              </span>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Man-min per 1,000 sqft
                </span>
                <NumberInput
                  value={draft.install_minutes_per_1000_sqft}
                  onChange={(n) =>
                    setDraft({ ...draft, install_minutes_per_1000_sqft: n })
                  }
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  Laying, fitting and rolling only — soil prep, grading and
                  old-turf removal are their own labor lines.
                </span>
              </label>
              {/* A suggestion beside the field, never a default in it. */}
              <p className="text-gray-500 text-xs">
                Published figure (suggestion only — never a default):{" "}
                {describeBenchmark(SOD_INSTALL_BENCHMARK)}
              </p>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">Notes</span>
                <textarea
                  className={field}
                  rows={3}
                  placeholder="Farm, lead time, minimum order"
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
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
                {editing ? "Save changes" : "Add sod"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
