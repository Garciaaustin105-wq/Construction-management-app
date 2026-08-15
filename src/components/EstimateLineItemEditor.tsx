"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { formatMoney, computeInternalCost } from "@/lib/money";
import type { PriorItem } from "@/lib/estimateHistory";
import NumberInput from "@/components/NumberInput";

export type EstimateLine = {
  cost_code_id: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  section: string;
  internal_cost: number | null;
};

export type CostCodeOption = {
  id: string;
  code: string;
  name: string;
};

type TemplateRow = {
  id: string;
  name: string;
  estimate_template_items: {
    cost_code_id: string | null;
    description: string | null;
    quantity: number;
    unit: string | null;
    unit_price: number;
    internal_cost: number | null;
    section: string | null;
    position: number;
  }[];
};

const UNITS = ["EA", "LF", "SF", "CF", "HR", "DAY", "LOT", "GAL", "TON", "%"];

// <datalist> id is shared across all line-item description inputs so the
// browser's native autocomplete pulldown shows previously used items.
const DESCRIPTION_DATALIST = "estimate-item-history";
const SECTION_DATALIST = "estimate-sections";

export default function EstimateLineItemEditor({
  items,
  onChange,
  costCodes,
  priorItems = [],
  disabled = false,
  allowTemplates = true,
}: {
  items: EstimateLine[];
  onChange: (next: EstimateLine[]) => void;
  costCodes: CostCodeOption[];
  priorItems?: PriorItem[];
  disabled?: boolean;
  // Template load/save is office-only. The editor already only renders at
  // office call sites, but this gate lets a future read-only reuse hide it.
  allowTemplates?: boolean;
}) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [savingTpl, setSavingTpl] = useState(false);

  // Load saved templates + the office user's org (needed to stamp a new
  // template's organization_id — RLS tier_office requires same_org).
  useEffect(() => {
    if (!allowTemplates || disabled) return;
    let cancelled = false;
    (async () => {
      const mod = await import("@/lib/supabase/client");
      const supabase = mod.createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", user.id)
        .single();
      if (cancelled) return;
      setUserId(user.id);
      setOrgId(profile?.organization_id ?? null);
      const { data: tpls } = await supabase
        .from("estimate_templates")
        .select(
          "id, name, estimate_template_items(cost_code_id, description, quantity, unit, unit_price, internal_cost, section, position)"
        )
        .order("name");
      if (!cancelled) setTemplates((tpls as TemplateRow[] | null) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [allowTemplates, disabled]);

  function update(idx: number, patch: Partial<EstimateLine>) {
    onChange(items.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  }

  // When the typed/selected description exactly matches a previously used
  // item, return a patch that brings forward its unit + unit price + section.
  // Only fills when the line still has default values so we never clobber a
  // manual edit. Returns a patch (NOT a state update) so the caller can merge
  // it with the description change in a SINGLE update() call — two separate
  // updates would both build off the stale `items` and the second one would
  // clobber the just-set description back to empty (the "dropdown name doesn't
  // paste" bug).
  function historyPatch(idx: number, description: string): Partial<EstimateLine> {
    const match = priorItems.find(
      (p) => p.description.toLowerCase() === description.trim().toLowerCase()
    );
    if (!match) return {};
    const item = items[idx];
    if (!item) return {};
    const patch: Partial<EstimateLine> = {};
    if (item.unit_price === 0 && match.unit_price > 0) {
      patch.unit_price = match.unit_price;
    }
    if ((!item.unit || item.unit === "EA") && match.unit) {
      patch.unit = match.unit;
    }
    if (!item.section && match.section) {
      patch.section = match.section;
    }
    return patch;
  }

  function add() {
    onChange([
      ...items,
      {
        cost_code_id: null,
        description: "",
        quantity: 1,
        unit: "EA",
        unit_price: 0,
        section: "",
        internal_cost: null,
      },
    ]);
  }

  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  function move(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }

  // Append a saved template's items to the current list (position = idx).
  function loadTemplate(tplId: string) {
    if (!tplId) return;
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) return;
    const carried = tpl.estimate_template_items
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((it) => ({
        cost_code_id: it.cost_code_id ?? null,
        description: it.description ?? "",
        quantity: Number(it.quantity) || 1,
        unit: it.unit ?? "EA",
        unit_price: Number(it.unit_price) || 0,
        section: it.section ?? "",
        internal_cost: it.internal_cost != null ? Number(it.internal_cost) : null,
      }));
    onChange([...items, ...carried]);
  }

  // Save the current valid items as a reusable template (prompts for a name).
  function customPrompt(message: string): string | null {
    return window.prompt(message);
  }
  async function saveAsTemplate() {
    const valid = items.filter(
      (i) => i.description.trim() || i.cost_code_id
    );
    if (valid.length === 0) return;
    const name = customPrompt("Name this template (e.g. 'Standard bathroom rough-in'):");
    if (!name?.trim() || !orgId || !userId) return;
    setSavingTpl(true);
    const mod = await import("@/lib/supabase/client");
    const supabase = mod.createClient();
    const { data: tpl, error } = await supabase
      .from("estimate_templates")
      .insert({
        organization_id: orgId,
        name: name.trim(),
        created_by: userId,
      })
      .select("id")
      .single();
    if (error || !tpl) {
      setSavingTpl(false);
      return;
    }
    const itemRows = valid.map((item, idx) => ({
      template_id: tpl.id,
      cost_code_id: item.cost_code_id ?? null,
      description: item.description.trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      internal_cost: item.internal_cost ?? null,
      section: item.section || null,
      position: idx,
    }));
    await supabase.from("estimate_template_items").insert(itemRows);
    // Refresh the list so the new template appears in the dropdown.
    const { data: tpls } = await supabase
      .from("estimate_templates")
      .select(
        "id, name, estimate_template_items(cost_code_id, description, quantity, unit, unit_price, internal_cost, section, position)"
      )
      .order("name");
    setTemplates((tpls as TemplateRow[] | null) ?? []);
    setSavingTpl(false);
  }

  const total = items.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const internalCostTotal = computeInternalCost(items);
  const margin = total - internalCostTotal;
  const marginPct = total > 0 ? (margin / total) * 100 : 0;

  // Unique non-empty sections already used — fed to the section <datalist>.
  const sectionsUsed = Array.from(
    new Set(items.map((i) => i.section.trim()).filter(Boolean))
  );

  return (
    <div className="space-y-2">
      {priorItems.length > 0 && (
        <datalist id={DESCRIPTION_DATALIST}>
          {priorItems.map((p) => (
            <option key={p.description} value={p.description} />
          ))}
        </datalist>
      )}
      {sectionsUsed.length > 0 && (
        <datalist id={SECTION_DATALIST}>
          {sectionsUsed.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}

      {/* Templates (office-only) */}
      {allowTemplates && !disabled && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-indigo-900 flex-shrink-0">
              Templates
            </span>
            <select
              onChange={(e) => {
                loadTemplate(e.target.value);
                e.target.value = "";
              }}
              defaultValue=""
              className="flex-1 min-w-0 px-2 py-1.5 border border-indigo-200 rounded-lg text-xs bg-white"
            >
              <option value="">Load template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={saveAsTemplate}
            disabled={savingTpl || items.filter((i) => i.description.trim() || i.cost_code_id).length === 0}
            className="w-full text-indigo-700 bg-white border border-indigo-200 py-1.5 rounded-lg text-xs font-semibold active:bg-indigo-50 disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            {savingTpl ? "Saving…" : "Save current lines as template"}
          </button>
        </div>
      )}

      {items.length === 0 && (
        <div className="text-center py-6 text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg">
          No line items yet. Tap &ldquo;Add line&rdquo; below.
        </div>
      )}

      {items.map((item, idx) => {
        const lineTotal = (item.quantity || 0) * (item.unit_price || 0);
        const lineCost =
          item.internal_cost != null
            ? (item.quantity || 0) * (Number(item.internal_cost) || 0)
            : null;
        const lineMargin = lineCost != null ? lineTotal - lineCost : null;
        const selectedCode = costCodes.find((c) => c.id === item.cost_code_id);
        return (
          <div
            key={idx}
            className="bg-white border border-gray-200 rounded-lg p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">
                Line {idx + 1}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={disabled || idx === 0}
                  className="text-gray-500 p-1 rounded hover:bg-gray-100 disabled:opacity-20"
                  title="Move up"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={disabled || idx === items.length - 1}
                  className="text-gray-500 p-1 rounded hover:bg-gray-100 disabled:opacity-20"
                  title="Move down"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  disabled={disabled}
                  className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-30"
                  title="Remove line"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Cost code — picking one auto-fills the description if blank */}
            <label className="block">
              <span className="text-xs text-gray-500">Cost code</span>
              <select
                value={item.cost_code_id ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  const code = id ? costCodes.find((c) => c.id === id) : null;
                  const patch: Partial<EstimateLine> = { cost_code_id: id };
                  // Auto-fill description from the code name only if the line's
                  // description is empty or matches the previously selected code's
                  // name (so we don't clobber a manually edited description).
                  if (code && (!item.description || item.description === selectedCode?.name)) {
                    patch.description = code.name;
                  }
                  update(idx, patch);
                }}
                disabled={disabled}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
              >
                <option value="">No code</option>
                {costCodes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </label>

            <input
              type="text"
              value={item.description}
              list={DESCRIPTION_DATALIST}
              onChange={(e) => {
                const v = e.target.value;
                // Single update: set the description AND bring forward any
                // matching history (unit/price/section) in one call so neither
                // clobbers the other.
                update(idx, { description: v, ...historyPatch(idx, v) });
              }}
              disabled={disabled}
              placeholder="Description (e.g. Cat6 cable run, labor)"
              className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />

            <div className="grid grid-cols-4 gap-2">
              <label className="block">
                <span className="text-xs text-gray-500">Qty</span>
                <NumberInput
                  value={item.quantity}
                  onChange={(n) => update(idx, { quantity: n })}
                  disabled={disabled}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Unit</span>
                <select
                  value={item.unit || ""}
                  onChange={(e) => update(idx, { unit: e.target.value })}
                  disabled={disabled}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                >
                  <option value="">—</option>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Unit $</span>
                <NumberInput
                  value={item.unit_price}
                  onChange={(n) => update(idx, { unit_price: n })}
                  disabled={disabled}
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <div className="block">
                <span className="text-xs text-gray-500">Total</span>
                <div className="mt-1 px-2 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm font-semibold text-right">
                  {formatMoney(lineTotal)}
                </div>
              </div>
            </div>

            {/* Row 3: section + internal cost + line margin (office-only) */}
            <div className="grid grid-cols-3 gap-2">
              <label className="block col-span-1">
                <span className="text-xs text-gray-500">Section</span>
                <input
                  type="text"
                  value={item.section}
                  list={SECTION_DATALIST}
                  onChange={(e) => update(idx, { section: e.target.value })}
                  disabled={disabled}
                  placeholder="e.g. Site work"
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500">Int. cost $</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.internal_cost ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    update(idx, {
                      internal_cost: v === "" ? null : parseFloat(v) || 0,
                    });
                  }}
                  disabled={disabled}
                  placeholder="—"
                  className="mt-1 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <div className="block">
                <span className="text-xs text-gray-500">Margin</span>
                <div
                  className={`mt-1 px-2 py-2 border rounded-lg text-xs font-semibold text-right ${
                    lineMargin == null
                      ? "bg-gray-50 border-gray-200 text-gray-400"
                      : lineMargin < 0
                      ? "bg-red-50 border-red-200 text-red-700"
                      : "bg-green-50 border-green-200 text-green-700"
                  }`}
                >
                  {lineMargin == null
                    ? "—"
                    : `${formatMoney(lineMargin)}`}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="w-full text-blue-600 bg-blue-50 border border-blue-200 py-2 rounded-lg text-sm font-semibold active:bg-blue-100 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        Add line
      </button>

      {items.length > 0 && (
        <div className="bg-gray-900 text-white rounded-lg p-4 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Estimate total (sell)</span>
            <span className="text-lg font-bold">{formatMoney(total)}</span>
          </div>
          {internalCostTotal > 0 && (
            <>
              <div className="flex items-center justify-between text-xs text-gray-300">
                <span>Internal cost</span>
                <span className="tabular-nums">{formatMoney(internalCostTotal)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300">Margin</span>
                <span
                  className={`tabular-nums font-semibold ${
                    margin < 0 ? "text-red-300" : "text-green-300"
                  }`}
                >
                  {formatMoney(margin)}{" "}
                  <span className="text-gray-400">
                    ({marginPct.toFixed(1)}%)
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}