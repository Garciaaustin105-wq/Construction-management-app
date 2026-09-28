"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Trees,
  X,
} from "lucide-react";
import { AREA_COLORS } from "@/lib/estimateAreas";
import DataTable from "@/components/ui/DataTable";
import { formatMoney } from "@/lib/money";
import {
  CATALOGUE_REGION_NOTE,
  CATALOGUE_STARTING_POINT_NOTE,
} from "@/lib/catalogueReadiness";
import {
  PLANT_CATEGORIES,
  createPlantProduct,
  createPlantSize,
  deactivatePlantProduct,
  deletePlantSize,
  marginPct,
  sortSizes,
  updatePlantProduct,
  updatePlantSize,
  type PlantCategory,
  type PlantProduct,
  type PlantSize,
  type PlantWithSizes,
} from "@/lib/plantProducts";

// The org's plant & tree catalog (lawn estimator phase 2). Office/PM CRUD
// straight through RLS (`plant_product_office_all` / `plant_size_office_all`,
// both tier_office_or_pm) via the plantProducts contract — no inline catalogue
// queries, no re-derived math.
//
// SPECIES AND SIZES ARE DIFFERENT ROWS: `plant_products` is the species
// ("Dwarf Yaupon Holly", identity only, no price) and `plant_product_sizes`
// is what you buy and sell ("3 gal — costs $9.50, sells $38"). One species
// expands to its sizes; one species open at a time.
//
// WHY DEACTIVATE RATHER THAN DELETE (surfaced in the UI, not just here): a
// placed plant snapshots its own name / size / price into the estimate at drop
// time, so deleting a product never corrupts history. But the catalog is the
// record of what the org sells, and a deleted row can't be placed again.
// Inactive plants stay visible (dimmed) and are simply withheld from the map's
// plant picker. Delete is kept for genuine mistakes — typos entered five
// seconds ago — and warns accordingly. Sizes get a real deletePlantSize from
// the contract (the species deliberately ships deactivate-only).
//
// DISPLAY RULES the contract forces on this screen (see marginPct /
// install_minutes comments there): a missing price renders margin as "—",
// never "0%"; install_minutes 0 is NOT ESTIMATED, not free, and renders as
// "—" too; margin is labelled MATERIAL margin because install labor is
// deliberately not in cost.

type Draft = {
  name: string;
  botanical_name: string;
  category: PlantCategory;
  color: string;
  notes: string;
  active: boolean;
};

type SizeDraft = {
  size: string;
  cost: number;
  unit_price: number;
  install_minutes: number;
};

const EMPTY: Draft = {
  name: "",
  botanical_name: "",
  // Shrubs are the most common catalogue entry and the readPlantSnapshot
  // fallback, so the form starts there.
  category: "shrub",
  color: AREA_COLORS[0],
  notes: "",
  active: true,
};

const EMPTY_SIZE: SizeDraft = {
  size: "",
  cost: 0,
  unit_price: 0,
  install_minutes: 0,
};

function toDraft(p: PlantProduct): Draft {
  return {
    name: p.name,
    botanical_name: p.botanical_name ?? "",
    category: p.category,
    color: p.color || AREA_COLORS[0],
    notes: p.notes ?? "",
    active: p.active,
  };
}

// "$16" for whole dollars, "$16.50" otherwise. The summary line reads like a
// nursery list, not an invoice.
function fmtWhole(n: number): string {
  return "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2));
}

// `4 sizes · $16–$140` — the collapsed row's summary. A species with no
// sizes says so: it can't be placed or priced until it has one.
function sizeSummary(p: PlantWithSizes): string {
  if (p.sizes.length === 0) return "No sizes yet";
  const prices = p.sizes.map((s) => Number(s.unit_price ?? 0));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range =
    min === max ? fmtWhole(min) : `${fmtWhole(min)}–${fmtWhole(max)}`;
  return `${p.sizes.length} size${p.sizes.length === 1 ? "" : "s"} · ${range}`;
}

export default function PlantCatalogueManager({
  initial,
  orgId,
}: {
  initial: PlantWithSizes[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [products, setProducts] = useState<PlantWithSizes[]>(initial);
  const [editing, setEditing] = useState<PlantProduct | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The size editor: exactly one species expanded at a time.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sizeEditing, setSizeEditing] = useState<PlantSize | null>(null);
  const [sizeDraft, setSizeDraft] = useState<SizeDraft>(EMPTY_SIZE);
  const [showSizeForm, setShowSizeForm] = useState(false);
  const [savingSize, setSavingSize] = useState(false);
  const [sizeBusyId, setSizeBusyId] = useState<string | null>(null);

  // Active first (matches the chemical catalog), then trees above shrubs —
  // PLANT_CATEGORIES is in planting-plan order, the same index buildPlantLegend
  // sorts by, so a legend and this list read the same way: canopy down to
  // groundcover, name within category.
  // "No price anywhere" is the day-one signal. Deliberately not a count or a
  // percentage: a progress bar over 690 rows would restate the cliff as a
  // graphic, when the true answer is that most of those rows never need a price
  // at all.
  const nothingPricedYet = useMemo(
    () =>
      products.length > 0 &&
      !products.some((p) =>
        p.sizes.some((z) => Number(z.unit_price ?? 0) > 0 || Number(z.cost ?? 0) > 0)
      ),
    [products]
  );

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

  // Search / category / active filter (Lane A). Client-side over `sorted` —
  // 223 seeded species render instantly and a server round-trip per keystroke
  // is unwanted. The text matches the COMMON name and the BOTANICAL name
  // both, because the office looks a plant up either way ("ilex" for a
  // holly). Category and the inactive toggle narrow further. The existing
  // sort is kept INSIDE the filtered set — filtering never re-orders, and
  // filtering never paginates: the whole filtered list renders.
  const [query, setQuery] = useState("");

  const [categoryFilter, setCategoryFilter] = useState<"all" | PlantCategory>(
    "all"
  );
  const [showInactive, setShowInactive] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (!showInactive && !p.active) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.botanical_name ?? "").toLowerCase().includes(q)
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

  function openEdit(p: PlantProduct) {
    setEditing(p);
    setDraft(toDraft(p));
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  function openSizes(p: PlantWithSizes) {
    setExpanded(expanded === p.id ? null : p.id);
    closeSizeForm();
  }

  function openSizeAdd() {
    setSizeEditing(null);
    setSizeDraft(EMPTY_SIZE);
    setShowSizeForm(true);
  }

  function openSizeEdit(s: PlantSize) {
    setSizeEditing(s);
    setSizeDraft({
      size: s.size,
      cost: Number(s.cost ?? 0),
      unit_price: Number(s.unit_price ?? 0),
      install_minutes: Number(s.install_minutes ?? 0),
    });
    setShowSizeForm(true);
  }

  function closeSizeForm() {
    setShowSizeForm(false);
    setSizeEditing(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      toast.warning("Plant name is required");
      return;
    }

    // Blank fields → null so they read as "not recorded" rather than
    // present-but-empty. A species carries NO price — prices live on sizes.
    const payload = {
      name,
      botanical_name: draft.botanical_name.trim() || null,
      category: draft.category,
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
      setProducts((prev) => [{ ...data, sizes: [] }, ...prev]);
      toast.success("Plant added");
    }
    closeForm();
  }

  async function toggleActive(p: PlantWithSizes) {
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

  async function remove(p: PlantWithSizes) {
    if (
      !confirm(
        `Delete "${p.name}"?\n\nPlaced plants keep their own snapshot of name, ` +
          "size and price, so past estimates stay intact — but this row can " +
          "never be placed again, and the catalog is your record of what you " +
          "sell. If you've stopped carrying it, deactivate it instead. " +
          "Its sizes are deleted with it."
      )
    ) {
      return;
    }
    setBusyId(p.id);
    // The contract deliberately ships deactivate-only for the species; this
    // one hard delete for typos is the same inline op the chemical catalog
    // uses. Sizes cascade in the DB (plant_product_id on delete cascade).
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
    if (expanded === p.id) setExpanded(null);
    toast.success("Plant deleted");
  }

  async function saveSize(e: React.FormEvent, productId: string) {
    e.preventDefault();
    const size = sizeDraft.size.trim();
    if (!size) {
      toast.warning("Size is required");
      return;
    }
    const payload = {
      size,
      cost: sizeDraft.cost,
      unit_price: sizeDraft.unit_price,
      install_minutes: sizeDraft.install_minutes,
    };
    setSavingSize(true);
    if (sizeEditing) {
      const error = await updatePlantSize(supabase, sizeEditing.id, payload);
      setSavingSize(false);
      if (error) {
        toast.error(error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId
            ? {
                ...p,
                sizes: sortSizes(
                  p.sizes.map((s) =>
                    s.id === sizeEditing.id ? { ...s, ...payload } : s
                  )
                ),
              }
            : p
        )
      );
      toast.success("Size updated");
    } else {
      // sort_order is never typed — it IS the position in the list, so a new
      // size lands after the last one. (Never alphabetical: "15 gal" would
      // sort before "3 gal".)
      const parent = products.find((p) => p.id === productId);
      const nextOrder =
        parent && parent.sizes.length > 0
          ? Math.max(...parent.sizes.map((s) => s.sort_order)) + 1
          : 0;
      const { data, error } = await createPlantSize(supabase, {
        organization_id: orgId,
        plant_product_id: productId,
        ...payload,
        sort_order: nextOrder,
      });
      setSavingSize(false);
      if (error || !data) {
        toast.error(error ?? "Could not add size");
        return;
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId ? { ...p, sizes: sortSizes([...p.sizes, data]) } : p
        )
      );
      toast.success("Size added");
    }
    closeSizeForm();
  }

  async function removeSize(productId: string, s: PlantSize) {
    if (
      !confirm(
        `Delete size "${s.size}"?\n\nPlaced plants keep their own snapshot of ` +
          "name, size and price, so past estimates stay intact — but this " +
          "size can no longer be placed."
      )
    ) {
      return;
    }
    setSizeBusyId(s.id);
    const error = await deletePlantSize(supabase, s.id);
    setSizeBusyId(null);
    if (error) {
      toast.error(error);
      return;
    }
    setProducts((prev) =>
      prev.map((p) =>
        p.id === productId
          ? { ...p, sizes: p.sizes.filter((x) => x.id !== s.id) }
          : p
      )
    );
    toast.success("Size deleted");
  }

  // The expanded species' size editor — rendered inside the mobile card and
  // inside a colSpan cell of the desktop table, so it is written once.
  function sizesBlock(p: PlantWithSizes) {
    return (
      <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 space-y-2">
        {p.sizes.length === 0 ? (
          <p className="text-[11px] font-medium text-amber-700">
            No sizes yet — this plant can&apos;t be placed on a map or priced
            until it has one.
          </p>
        ) : (
          p.sizes.map((s) => {
            const margin = marginPct(Number(s.cost ?? 0), Number(s.unit_price ?? 0));
            const minutes = Number(s.install_minutes ?? 0);
            return (
              <div key={s.id} className="flex items-start gap-2 text-xs">
                <span className="font-semibold text-gray-900 min-w-[64px]">
                  {s.size}
                </span>
                <div className="flex-1 min-w-0 flex flex-wrap gap-x-3 gap-y-0.5 text-gray-500 tabular-nums">
                  <span>cost {formatMoney(Number(s.cost ?? 0))}</span>
                  <span>{formatMoney(Number(s.unit_price ?? 0))} installed</span>
                  {/* Missing is not zero: no price → "—", and the label must
                      say material — install labor is not in cost. */}
                  <span>
                    {margin === null
                      ? "—"
                      : `${Math.round(margin * 100)}% material margin`}
                  </span>
                  {/* 0 = not estimated, not free. */}
                  <span>{minutes > 0 ? `${minutes} man-min` : "—"}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => openSizeEdit(s)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={`Edit size ${s.size}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => removeSize(p.id, s)}
                    disabled={sizeBusyId === s.id}
                    className="text-gray-300 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Delete size ${s.size}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}

        {showSizeForm && (
          <form
            onSubmit={(e) => saveSize(e, p.id)}
            className="border-t border-gray-200 pt-2 space-y-2"
          >
            <input
              autoFocus
              className={field}
              placeholder="Size (3 gal, #5, 2in cal, B&B) *"
              value={sizeDraft.size}
              onChange={(e) =>
                setSizeDraft({ ...sizeDraft, size: e.target.value })
              }
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Cost per plant ($)
                </span>
                <NumberInput
                  value={sizeDraft.cost}
                  onChange={(n) => setSizeDraft({ ...sizeDraft, cost: n })}
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  What the nursery charges you — material only.
                </span>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-600">
                  Price ($)
                </span>
                <NumberInput
                  value={sizeDraft.unit_price}
                  onChange={(n) =>
                    setSizeDraft({ ...sizeDraft, unit_price: n })
                  }
                  placeholder="0"
                  className={`${field} mt-1`}
                />
                <span className="mt-1 block text-[11px] text-gray-400">
                  What the customer pays, installed.
                </span>
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-gray-600">
                Install time (man-minutes)
              </span>
              <NumberInput
                value={sizeDraft.install_minutes}
                onChange={(n) =>
                  setSizeDraft({ ...sizeDraft, install_minutes: n })
                }
                placeholder="0"
                className={`${field} mt-1`}
              />
              <span className="mt-1 block text-[11px] text-gray-400">
                Two people × 10 min = 20 man-minutes. Leave 0 if not estimated
                — it never quotes labor as free.
              </span>
            </label>
            <button
              type="submit"
              disabled={savingSize}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800 disabled:opacity-50"
            >
              {savingSize && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {sizeEditing ? "Save size" : "Add size"}
            </button>
          </form>
        )}

        {!showSizeForm && (
          <button
            onClick={openSizeAdd}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-gray-300 rounded-lg px-2.5 py-1.5 active:bg-gray-100"
          >
            <Plus className="h-3.5 w-3.5" />
            Add size
          </button>
        )}
      </div>
    );
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-3">
      {/*
        Shown only until the org prices its FIRST size, then never again.
        A permanent banner becomes wallpaper, and this one has a job that ends:
        the shipped catalogue arrives with 690 blank prices, which reads as 690
        units of homework, and a person who believes that closes the tab. It is
        a list to pick from. Once they have priced one thing they know that, and
        the banner is in the way.
      */}
      {nothingPricedYet && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5">
          <p className="text-[11px] leading-snug text-slate-700">
            {CATALOGUE_STARTING_POINT_NOTE}
          </p>
          <p className="text-[11px] leading-snug text-slate-500">
            {CATALOGUE_REGION_NOTE}
          </p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {filtered.length === products.length
            ? `${products.length} species`
            : `${filtered.length} of ${products.length} species`}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add plant
        </button>
      </div>

      {/* Search / category / active filter — client-side, above the list. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search plants"
          className={`${field} flex-1 min-w-40`}
          placeholder="Search common or botanical name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter plants by category"
          className={`${field} w-40`}
          value={categoryFilter}
          onChange={(e) =>
            setCategoryFilter(e.target.value as "all" | PlantCategory)
          }
        >
          <option value="all">All categories</option>
          {PLANT_CATEGORIES.map((c) => (
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
            className="text-xs text-blue-700 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {products.length === 0 ? (
        <div className="text-center py-10 space-y-3">
          <p className="text-sm text-gray-500">
            Your plant &amp; tree catalog is empty. Add the plants you sell,
            then give each one its sizes and installed prices, so they can be
            dropped and priced on an estimate map.
          </p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first plant
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          No species match this search. Clear the filters to see the full
          catalog.
        </p>
      ) : (
        // Desktop UI pass: the mobile card JSX moved verbatim into mobileCard
        // (bare — per-row dimming kept via the function form of
        // mobileCardClassName; the size editor renders inside the card when
        // expanded) and the desktop table joined the shared DataTable idiom.
        // The species' size editor is also the lg+ rowExpansion. No rowHref:
        // rows don't navigate, actions are the affordance. mobileListClassName
        // pins the pre-migration wrapper class order ("space-y-2 lg:hidden")
        // so the mobile DOM is byte-identical, not merely equivalent.
        <DataTable
          columns={[
            {
              key: "name",
              header: "Plant",
              cell: (p) => (
                <span className="font-medium text-gray-900">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full border border-black/10 align-middle"
                    style={{ backgroundColor: p.color }}
                  />
                  {p.name}
                  {p.botanical_name && (
                    <span className="ml-2 text-xs font-normal text-gray-400 italic">
                      {p.botanical_name}
                    </span>
                  )}
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
              cell: (p) => <span className="text-gray-600 capitalize">{p.category}</span>,
              hideOnMobile: true,
            },
            {
              key: "sizes",
              header: "Sizes",
              cell: (p) => (
                <span
                  className={
                    p.sizes.length === 0
                      ? "font-medium text-amber-700"
                      : "text-gray-600"
                  }
                >
                  {sizeSummary(p)}
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
                    onClick={() => openSizes(p)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={
                      expanded === p.id
                        ? `Hide sizes for ${p.name}`
                        : `Show sizes for ${p.name}`
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
                  <button
                    onClick={() => remove(p)}
                    disabled={busyId === p.id}
                    className="text-gray-300 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ),
            },
          ]}
          rows={filtered}
          framed
          rowExpansion={(p) => (expanded === p.id ? sizesBlock(p) : null)}
          mobileListClassName="space-y-2 lg:hidden"
          mobileCardBare
          mobileCardClassName={(p) =>
            `bg-white rounded-lg p-3 shadow-sm ${p.active ? "" : "opacity-60"}`
          }
          mobileCard={(p) => (
            <>
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
                  {p.botanical_name && (
                    <p className="text-xs text-gray-400 italic truncate">
                      {p.botanical_name}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                    <span className="capitalize">{p.category}</span>
                    <span
                      className={
                        p.sizes.length === 0
                          ? "font-medium text-amber-700"
                          : ""
                      }
                    >
                      {sizeSummary(p)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    onClick={() => openSizes(p)}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={
                      expanded === p.id
                        ? `Hide sizes for ${p.name}`
                        : `Show sizes for ${p.name}`
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
              {expanded === p.id && sizesBlock(p)}
            </>
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
              <input
                className={field}
                placeholder="Botanical name (optional)"
                value={draft.botanical_name}
                onChange={(e) =>
                  setDraft({ ...draft, botanical_name: e.target.value })
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

