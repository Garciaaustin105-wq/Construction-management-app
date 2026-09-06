"use client";

// Machinery catalogue (Lane A). Equipment is the odd catalogue: it holds TWO
// cost models at once, and this screen's form changes shape with the
// ownership toggle rather than showing one giant form with half of it greyed
// out —
//
//   OWNED   an hourly internal rate only (depreciation, fuel, maintenance).
//           No rent, no delivery. Without that rate the machine quotes at
//           ZERO and every job using it looks more profitable than it is —
//           the single most expensive invisible mistake in this subject area,
//           so a machine saved in that state carries a visible warning in the
//           list, not just a hint in the form.
//
//   RENTED  daily / weekly / monthly cost + price, plus delivery and pickup
//           once per rental. The periods are not multiples of each other: a
//           rental week is well below seven days, so five days multiplied out
//           can cost more than the week — the live cheapestPlan preview shows
//           exactly that for 1 day, 5 days and 2 weeks.
//
// Every rate is nullable and NULL MEANS NOT RECORDED, never free. The rate
// boxes therefore render empty (NumberInput shows nothing for 0) and a save
// maps 0 back to null — a rate the office has not recorded must never reach
// an estimate looking like $0.00. `rates_updated_at` is surfaced as
// rateAgeDays: "rates 41 days old" or "never priced", because a stale rental
// rate quoted as current is a silent margin leak.

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import DataTable from "@/components/ui/DataTable";
import { Loader2, Pencil, Plus, Tractor, X } from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  EQUIPMENT_CATEGORIES,
  OWNERSHIP,
  cheapestPlan,
  createEquipment,
  rateAgeDays,
  updateEquipment,
  type EquipmentCategory,
  type EquipmentProduct,
  type NewEquipmentProduct,
  type Ownership,
} from "@/lib/equipmentProducts";

type Draft = {
  name: string;
  category: EquipmentCategory;
  ownership: Ownership;
  // Nullable rates as numbers — 0 renders empty in NumberInput and maps back
  // to null on save, so "not recorded" can never masquerade as free.
  cost_hourly: number;
  price_hourly: number;
  cost_daily: number;
  price_daily: number;
  cost_weekly: number;
  price_weekly: number;
  cost_monthly: number;
  price_monthly: number;
  delivery_fee: number;
  pickup_fee: number;
  operator_required: boolean;
  notes: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: "",
  category: "skid_steer",
  ownership: "rented",
  cost_hourly: 0,
  price_hourly: 0,
  cost_daily: 0,
  price_daily: 0,
  cost_weekly: 0,
  price_weekly: 0,
  cost_monthly: 0,
  price_monthly: 0,
  delivery_fee: 0,
  pickup_fee: 0,
  operator_required: true,
  notes: "",
  active: true,
};

function toDraft(p: EquipmentProduct): Draft {
  return {
    name: p.name,
    category: p.category,
    ownership: p.ownership,
    cost_hourly: Number(p.cost_hourly ?? 0),
    price_hourly: Number(p.price_hourly ?? 0),
    cost_daily: Number(p.cost_daily ?? 0),
    price_daily: Number(p.price_daily ?? 0),
    cost_weekly: Number(p.cost_weekly ?? 0),
    price_weekly: Number(p.price_weekly ?? 0),
    cost_monthly: Number(p.cost_monthly ?? 0),
    price_monthly: Number(p.price_monthly ?? 0),
    delivery_fee: Number(p.delivery_fee ?? 0),
    pickup_fee: Number(p.pickup_fee ?? 0),
    operator_required: p.operator_required,
    notes: p.notes ?? "",
    active: p.active,
  };
}

// The recorded-but-nullable contract: 0 (or an empty box) means the office
// has not priced it — send null so downstream can never read it as free.
const nullableRate = (n: number): number | null => (n > 0 ? n : null);

const unpricedChip = (
  <span className="ml-1 bg-amber-200 text-amber-800 text-xs px-1 rounded">
    unpriced
  </span>
);

// One compact cell: which rates exist and what they are. Only recorded rates
// show — an unrecorded period renders nothing at all, never "$0".
function ratesCell(p: EquipmentProduct) {
  if (p.ownership === "owned") {
    const warned = !(p.cost_hourly && p.cost_hourly > 0);
    return (
      <span className="text-gray-600 tabular-nums">
        {p.cost_hourly ? `${formatMoney(Number(p.cost_hourly))}/hr` : "—"}
        {" cost · "}
        {p.price_hourly ? `${formatMoney(Number(p.price_hourly))}/hr` : "—"}
        {" price"}
        {warned && unpricedChip}
      </span>
    );
  }
  const parts: string[] = [];
  if (p.price_daily) parts.push(`D ${formatMoney(Number(p.price_daily))}`);
  if (p.price_weekly) parts.push(`W ${formatMoney(Number(p.price_weekly))}`);
  if (p.price_monthly) parts.push(`M ${formatMoney(Number(p.price_monthly))}`);
  return (
    <span className="text-gray-600 tabular-nums">
      {parts.length > 0 ? parts.join(" · ") : "—"}
      {parts.length === 0 && unpricedChip}
    </span>
  );
}

// "rates 41 days old" / "never priced". Null is never shown as "0 days" —
// the contract is explicit that never-priced is its own state.
function ageLabel(p: EquipmentProduct): string {
  const days = rateAgeDays(p);
  if (days === null) return "rates never priced";
  if (days === 0) return "rates current";
  if (days === 1) return "rates 1 day old";
  return `rates ${days} days old`;
}

export default function EquipmentProductsManager({
  initial,
  orgId,
}: {
  initial: EquipmentProduct[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [products, setProducts] = useState<EquipmentProduct[]>(initial);
  const [editing, setEditing] = useState<EquipmentProduct | null>(null);
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

  function openEdit(p: EquipmentProduct) {
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
      toast.warning("Machine name is required");
      return;
    }

    // The ownership toggle decides which rate columns the row carries at all.
    // A rented machine carries NO hourly rates and an owned one carries NO
    // period rates — nulling the irrelevant half keeps the two cost models
    // from bleeding into each other.
    const rates =
      draft.ownership === "owned"
        ? {
            cost_hourly: nullableRate(draft.cost_hourly),
            price_hourly: nullableRate(draft.price_hourly),
            cost_daily: null,
            price_daily: null,
            cost_weekly: null,
            price_weekly: null,
            cost_monthly: null,
            price_monthly: null,
            delivery_fee: 0,
            pickup_fee: 0,
          }
        : {
            cost_hourly: null,
            price_hourly: null,
            cost_daily: nullableRate(draft.cost_daily),
            price_daily: nullableRate(draft.price_daily),
            cost_weekly: nullableRate(draft.cost_weekly),
            price_weekly: nullableRate(draft.price_weekly),
            cost_monthly: nullableRate(draft.cost_monthly),
            price_monthly: nullableRate(draft.price_monthly),
            delivery_fee: draft.delivery_fee,
            pickup_fee: draft.pickup_fee,
          };

    const payload: NewEquipmentProduct = {
      organization_id: orgId,
      name,
      category: draft.category,
      ownership: draft.ownership,
      ...rates,
      operator_required: draft.operator_required,
      notes: draft.notes.trim() || null,
    };

    setSaving(true);
    if (editing) {
      const error = await updateEquipment(supabase, editing.id, {
        name,
        category: draft.category,
        ownership: draft.ownership,
        ...rates,
        operator_required: draft.operator_required,
        notes: draft.notes.trim() || null,
        active: draft.active,
      });
      setSaving(false);
      if (error) {
        toast.error(error);
        return;
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === editing.id
            ? {
                ...p,
                ...payload,
                active: draft.active,
                // The contract stamps rates_updated_at on any rate change;
                // mirror that locally so the age label moves without a refetch.
                rates_updated_at: new Date().toISOString(),
              }
            : p
        )
      );
      toast.success("Machine updated");
    } else {
      const { data, error } = await createEquipment(supabase, payload);
      setSaving(false);
      if (error || !data) {
        toast.error(error ?? "Could not add machine");
        return;
      }
      setProducts((prev) => [data, ...prev]);
      toast.success("Machine added");
    }
    closeForm();
  }

  async function toggleActive(p: EquipmentProduct) {
    setBusyId(p.id);
    const next = !p.active;
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: next } : x))
    );
    const error = await updateEquipment(supabase, p.id, { active: next });
    setBusyId(null);
    if (error) {
      setProducts((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, active: p.active } : x))
      );
      toast.error(error);
    }
  }

  // Live cheapestPlan preview for a RENTED machine, from the draft's cost
  // rates. 1 day, 5 days and 2 weeks: the five-day row is the one that
  // teaches the lesson, because it is the case where taking the week is
  // cheaper than multiplying the daily rate — and the preview shows the plan
  // the contract would actually pick, not the multiplication.
  function planPreview(days: number) {
    const plan = cheapestPlan(days, {
      daily: nullableRate(draft.cost_daily),
      weekly: nullableRate(draft.cost_weekly),
      monthly: nullableRate(draft.cost_monthly),
    });
    if (plan.unpriced) {
      return (
        <span className="text-amber-700">
          {plan.label} — no rental rates recorded
        </span>
      );
    }
    return (
      <span className="text-gray-600 tabular-nums">
        {plan.label} · {formatMoney(plan.total)}
      </span>
    );
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  // The ownership-dependent rate fields. Rendered as two functions of the
  // draft rather than one conditional blob so each half reads on its own.
  const ownedRates = (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="text-xs font-medium text-gray-600">
          Cost per hour ($)
        </span>
        <NumberInput
          value={draft.cost_hourly}
          onChange={(n) => setDraft({ ...draft, cost_hourly: n })}
          placeholder="not recorded"
          className={`${field} mt-1`}
        />
        <span className="mt-1 block text-[11px] text-gray-400">
          Fuel, maintenance, depreciation — what the machine really costs to
          run.
        </span>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">
          Price per hour ($)
        </span>
        <NumberInput
          value={draft.price_hourly}
          onChange={(n) => setDraft({ ...draft, price_hourly: n })}
          placeholder="not recorded"
          className={`${field} mt-1`}
        />
        <span className="mt-1 block text-[11px] text-gray-400">
          What the customer is billed per hour of use.
        </span>
      </label>
      {/* The silent one, surfaced while typing rather than only after saving:
          an owned machine with no hourly cost quotes at zero. */}
      {draft.cost_hourly <= 0 && (
        <p className="col-span-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          No hourly cost — this machine will quote at zero and every job using
          it will look more profitable than it is.
        </p>
      )}
    </div>
  );

  const rentedRates = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Cost per day ($)
          </span>
          <NumberInput
            value={draft.cost_daily}
            onChange={(n) => setDraft({ ...draft, cost_daily: n })}
            placeholder="not recorded"
            className={`${field} mt-1`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Price per day ($)
          </span>
          <NumberInput
            value={draft.price_daily}
            onChange={(n) => setDraft({ ...draft, price_daily: n })}
            placeholder="not recorded"
            className={`${field} mt-1`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Cost per week ($)
          </span>
          <NumberInput
            value={draft.cost_weekly}
            onChange={(n) => setDraft({ ...draft, cost_weekly: n })}
            placeholder="not recorded"
            className={`${field} mt-1`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Price per week ($)
          </span>
          <NumberInput
            value={draft.price_weekly}
            onChange={(n) => setDraft({ ...draft, price_weekly: n })}
            placeholder="not recorded"
            className={`${field} mt-1`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Cost per month ($)
          </span>
          <NumberInput
            value={draft.cost_monthly}
            onChange={(n) => setDraft({ ...draft, cost_monthly: n })}
            placeholder="not recorded"
            className={`${field} mt-1`}
          />
          <span className="mt-1 block text-[11px] text-gray-400">
            Rental &quot;months&quot; are usually 28 days.
          </span>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Price per month ($)
          </span>
          <NumberInput
            value={draft.price_monthly}
            onChange={(n) => setDraft({ ...draft, price_monthly: n })}
            placeholder="not recorded"
            className={`${field} mt-1`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Delivery fee ($)
          </span>
          <NumberInput
            value={draft.delivery_fee}
            onChange={(n) => setDraft({ ...draft, delivery_fee: n })}
            placeholder="0"
            className={`${field} mt-1`}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Pickup fee ($)
          </span>
          <NumberInput
            value={draft.pickup_fee}
            onChange={(n) => setDraft({ ...draft, pickup_fee: n })}
            placeholder="0"
            className={`${field} mt-1`}
          />
          <span className="mt-1 block text-[11px] text-gray-400">
            Per rental, not per day.
          </span>
        </label>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-2.5">
        <p className="text-xs font-medium text-gray-700 mb-1.5">
          Cheapest plan for a rental of —
        </p>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">1 day</span>
            {planPreview(1)}
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">5 days</span>
            {planPreview(5)}
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-gray-500">2 weeks</span>
            {planPreview(14)}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">
          A week is usually far less than seven daily rates — five days often
          costs the week, and the estimate always takes the cheaper one.
        </p>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {products.length} machine{products.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          Add machine
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-10 space-y-3">
          <p className="text-sm text-gray-500">
            No machinery in your catalog yet. Add the machines you own or rent
            — owned ones carry an hourly cost, rented ones carry daily, weekly
            and monthly rates.
          </p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add your first machine
          </button>
        </div>
      ) : (
        <DataTable
          columns={[
            {
              key: "name",
              header: "Machine",
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
              cell: (p) => (
                <span className="text-gray-600">
                  {p.category.replace(/_/g, " ")}
                </span>
              ),
              hideOnMobile: true,
            },
            {
              key: "ownership",
              header: "Owned?",
              cell: (p) => (
                <span
                  className={`text-xs font-medium ${
                    p.ownership === "owned"
                      ? "text-gray-700"
                      : "text-blue-700"
                  }`}
                >
                  {p.ownership === "owned" ? "Owned" : "Rented"}
                </span>
              ),
            },
            {
              key: "rates",
              header: "Rates",
              cell: ratesCell,
              hideOnMobile: true,
            },
            {
              key: "age",
              header: "Rate age",
              cell: (p) => {
                const days = rateAgeDays(p);
                return (
                  <span
                    className={`text-xs tabular-nums ${
                      days === null ? "text-amber-700" : "text-gray-400"
                    }`}
                  >
                    {ageLabel(p)}
                  </span>
                );
              },
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
              <Tractor className="h-4 w-4 text-gray-400 shrink-0 mt-0.5" />
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
                  {p.ownership === "owned" ? "Owned" : "Rented"} ·{" "}
                  {p.category.replace(/_/g, " ")}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                  <span>{ageLabel(p)}</span>
                  {p.ownership === "owned" &&
                    !(p.cost_hourly && p.cost_hourly > 0) && (
                      <span className="font-medium text-amber-700">
                        quotes at zero
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
            aria-label={editing ? `Edit ${editing.name}` : "Add machine"}
            className="w-full sm:w-[440px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit machine" : "Add machine"}
              </h2>
              <button
                onClick={closeForm}
                aria-label="Close"
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            {/* pb-24: the fixed mobile BottomNav (z-50) overlays the bottom
                of this drawer, and without clearance the submit button can
                never scroll above it — unreachable on a phone at full
                scroll. */}
            <form onSubmit={save} className="p-4 pb-24 space-y-3">
              <input
                autoFocus
                className={field}
                placeholder="Machine name (Bobcat S650, 48&#39; skid steer) *"
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
                      category: e.target.value as EquipmentCategory,
                    })
                  }
                >
                  {EQUIPMENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>

              {/* Ownership drives the rest of the form. Two explicit buttons,
                  not a select — the swap it causes is the point. */}
              <div>
                <span className="text-xs font-medium text-gray-600">
                  Is this machine owned or rented?
                </span>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {OWNERSHIP.map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => setDraft({ ...draft, ownership: o })}
                      className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                        draft.ownership === o
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-gray-300 bg-white text-gray-700"
                      }`}
                    >
                      {o === "owned" ? "Owned" : "Rented"}
                    </button>
                  ))}
                </div>
              </div>

              {draft.ownership === "owned" ? ownedRates : rentedRates}

              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.operator_required}
                  onChange={(e) =>
                    setDraft({ ...draft, operator_required: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300 mt-0.5"
                />
                <span>
                  Needs an operator
                  <span className="block text-[11px] text-gray-400 font-normal">
                    The operator is LABOR, not equipment — their hours are
                    counted in the labor math. This flag only warns when a
                    machine is estimated with no labor to run it.
                  </span>
                </span>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-gray-600">Notes</span>
                <textarea
                  className={`${field} mt-1`}
                  rows={3}
                  placeholder="Notes"
                  value={draft.notes}
                  onChange={(e) =>
                    setDraft({ ...draft, notes: e.target.value })
                  }
                />
              </label>

              {editing && (
                <p
                  className={`text-xs ${
                    rateAgeDays(editing) === null
                      ? "text-amber-700"
                      : "text-gray-400"
                  }`}
                >
                  {ageLabel(editing)}
                  {editing.rates_updated_at && rateAgeDays(editing) !== null
                    ? " — saving a rate updates the date"
                    : ""}
                </p>
              )}

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) =>
                    setDraft({ ...draft, active: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                Active (available when estimating)
              </label>

              <button
                type="submit"
                disabled={saving}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Add machine"}
              </button>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}