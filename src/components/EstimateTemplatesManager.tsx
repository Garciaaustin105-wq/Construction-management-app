// src/components/EstimateTemplatesManager.tsx

"use client";

/**
 * EstimateTemplatesManager
 *
 * CRUD manager for reusable estimate line‑item templates.
 * Mirrors ChemicalProductsManager: client‑side CRUD via Supabase RLS,
 * no /api routes, same layout feel.
 *
 * The component receives an initial list of templates and the orgId to stamp
 * new templates with.  All mutations re‑query the list to stay in sync.
 */

import { useState, useMemo, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { Beaker, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { formatMoney } from "@/lib/money";

export type TemplateWithItems = {
  id: string;
  name: string;
  description: string | null;
  estimate_template_items: {
    description: string | null;
    quantity: number;
    unit: string | null;
    unit_price: number;
    internal_cost: number | null;
    section: string | null;
    position: number;
  }[];
};

const UNITS = [
  "EA",
  "LF",
  "SF",
  "CF",
  "HR",
  "DAY",
  "LOT",
  "GAL",
  "TON",
  "%",
];

export default function EstimateTemplatesManager({
  initial,
  orgId,
}: {
  initial: TemplateWithItems[];
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [templates, setTemplates] = useState<TemplateWithItems[]>(initial);
  const [editing, setEditing] = useState<TemplateWithItems | null>(null);
  const [draft, setDraft] = useState<TemplateWithItems | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Load current user for stamping created_by on new templates
  useEffect(() => {
    async function fetchUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) setUserId(user.id);
    }
    fetchUser();
  }, [supabase]);

  const sorted = useMemo(
    () => [...templates].sort((a, b) => a.name.localeCompare(b.name)),
    [templates]
  );

  async function refresh() {
    const { data, error: err } = await supabase
      .from("estimate_templates")
      .select(
        "id, name, description, estimate_template_items(description, quantity, unit, unit_price, internal_cost, section, position)"
      )
      .order("name");
    if (err) {
      toast.error(err.message);
      return;
    }
    setTemplates(data as TemplateWithItems[]);
  }

  function openNew() {
    setEditing(null);
    setDraft({
      id: "",
      name: "",
      description: null,
      estimate_template_items: [],
    });
    setError(null);
  }

  function openEdit(t: TemplateWithItems) {
    setEditing(t);
    setDraft({ ...t });
    setError(null);
  }

  function closeForm() {
    setEditing(null);
    setDraft(null);
    setError(null);
    setSaving(false);
    setBusyId(null);
  }

  async function handleSave() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Template name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (draft.id) {
        // Update existing template
        const { error: updErr } = await supabase
          .from("estimate_templates")
          .update({ name, description: draft.description })
          .eq("id", draft.id);
        if (updErr) throw updErr;

        // Delete old items
        const { error: delErr } = await supabase
          .from("estimate_template_items")
          .delete()
          .eq("template_id", draft.id);
        if (delErr) throw delErr;

        // Insert new items
        const itemRows = draft.estimate_template_items.map((it, idx) => ({
          template_id: draft.id,
          description: it.description ?? null,
          quantity: it.quantity,
          unit: it.unit ?? null,
          unit_price: it.unit_price,
          internal_cost: it.internal_cost ?? null,
          section: it.section ?? null,
          position: idx,
        }));
        if (itemRows.length > 0) {
          const { error: insErr } = await supabase
            .from("estimate_template_items")
            .insert(itemRows);
          if (insErr) throw insErr;
        }
      } else {
        // Insert new template
        const { data: tpl, error: insErr } = await supabase
          .from("estimate_templates")
          .insert({
            organization_id: orgId,
            name,
            description: draft.description,
            created_by: userId ?? undefined,
          })
          .select("id")
          .single();
        if (insErr || !tpl) throw insErr ?? new Error("Insert failed");
        const newId = tpl.id;

        // Insert items
        const itemRows = draft.estimate_template_items.map((it, idx) => ({
          template_id: newId,
          description: it.description ?? null,
          quantity: it.quantity,
          unit: it.unit ?? null,
          unit_price: it.unit_price,
          internal_cost: it.internal_cost ?? null,
          section: it.section ?? null,
          position: idx,
        }));
        if (itemRows.length > 0) {
          const { error: insErr2 } = await supabase
            .from("estimate_template_items")
            .insert(itemRows);
          if (insErr2) throw insErr2;
        }
      }
      await refresh();
      closeForm();
      toast.success("Template saved");
    } catch (e: any) {
      setError(e.message ?? "Error saving template");
      toast.error(e.message ?? "Error saving template");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: TemplateWithItems) {
    if (
      !confirm(
        `Delete "${t.name}"?\n\nPast estimates keep their own record of this template, so history stays intact — but you won't be able to pick it again.`
      )
    )
      return;
    setBusyId(t.id);
    try {
      const { error: delItemsErr } = await supabase
        .from("estimate_template_items")
        .delete()
        .eq("template_id", t.id);
      if (delItemsErr) throw delItemsErr;
      const { error: delTplErr } = await supabase
        .from("estimate_templates")
        .delete()
        .eq("id", t.id);
      if (delTplErr) throw delTplErr;
      await refresh();
      toast.success(`Template "${t.name}" deleted`);
    } catch (e: any) {
      toast.error(e.message ?? "Error deleting template");
    } finally {
      setBusyId(null);
    }
  }

  function addItem() {
    if (!draft) return;
    setDraft({
      ...draft,
      estimate_template_items: [
        ...draft.estimate_template_items,
        {
          description: null,
          quantity: 1,
          unit: "EA",
          unit_price: 0,
          internal_cost: null,
          section: null,
          position: draft.estimate_template_items.length,
        },
      ],
    });
  }

  function removeItem(idx: number) {
    if (!draft) return;
    setDraft({
      ...draft,
      estimate_template_items: draft.estimate_template_items.filter(
        (_, i) => i !== idx
      ),
    });
  }

  function updateItem(idx: number, patch: Partial<TemplateWithItems["estimate_template_items"][0]>) {
    if (!draft) return;
    setDraft({
      ...draft,
      estimate_template_items: draft.estimate_template_items.map((it, i) =>
        i === idx ? { ...it, ...patch } : it
      ),
    });
  }

  const total = draft?.estimate_template_items.reduce(
    (sum, it) => sum + (it.quantity || 0) * (it.unit_price || 0),
    0
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {templates.length} template{templates.length === 1 ? "" : "s"}
        </p>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          New template
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-10">
          No templates yet. Add one to start building your catalog.
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((t) => (
            <li
              key={t.id}
              className="bg-white rounded-lg p-3 shadow-sm flex items-center justify-between"
            >
              <div>
                <p className="text-lg font-semibold">{t.name}</p>
                <p className="text-sm text-gray-500 truncate">
                  {t.description ?? "—"}
                </p>
                <p className="text-sm text-gray-500">
                  {t.estimate_template_items.length} item
                  {t.estimate_template_items.length === 1 ? "" : "s"}
                </p>
                <p className="text-sm text-gray-500">
                  Total: {formatMoney(
                    t.estimate_template_items.reduce(
                      (sum, it) => sum + (it.quantity || 0) * (it.unit_price || 0),
                      0
                    )
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openEdit(t)}
                  className="text-gray-400 hover:text-gray-700"
                  aria-label={`Edit ${t.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(t)}
                  disabled={busyId === t.id}
                  className="text-[11px] text-slate-600 hover:underline disabled:opacity-50"
                >
                  {busyId === t.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Delete"
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Drawer for editing/creating */}
      {(editing !== null || draft !== null) && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-black/40"
            onClick={closeForm}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={editing ? `Edit ${editing.name}` : "New template"}
            className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl"
          >
            <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                {editing ? "Edit template" : "New template"}
              </h2>
              <button
                onClick={closeForm}
                aria-label="Close"
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            <form onSubmit={(e) => { e.preventDefault(); handleSave(); }} className="p-4 space-y-3">
              <input
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                placeholder="Template name *"
                value={draft?.name ?? ""}
                onChange={(e) =>
                  setDraft({ ...(draft as TemplateWithItems), name: e.target.value })
                }
              />
              <textarea
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                placeholder="Description"
                value={draft?.description ?? ""}
                onChange={(e) =>
                  setDraft({ ...(draft as TemplateWithItems), description: e.target.value })
                }
              />

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              <div className="space-y-2">
                {draft?.estimate_template_items.map((it, idx) => (
                  <div
                    key={idx}
                    className="bg-white border border-gray-200 rounded-lg p-3 space-y-2"
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="text-xs font-medium text-gray-600">
                          Description
                        </span>
                        <input
                          type="text"
                          className="w-full px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
                          value={it.description ?? ""}
                          onChange={(e) =>
                            updateItem(idx, { description: e.target.value })
                          }
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-gray-600">
                          Section
                        </span>
                        <input
                          type="text"
                          className="w-full px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
                          value={it.section ?? ""}
                          onChange={(e) =>
                            updateItem(idx, { section: e.target.value })
                          }
                        />
                      </label>
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      <label className="block">
                        <span className="text-xs font-medium text-gray-600">
                          Qty
                        </span>
                        <NumberInput
                          value={it.quantity}
                          onChange={(n) => updateItem(idx, { quantity: n })}
                          className="w-full px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-gray-600">
                          Unit
                        </span>
                        <select
                          className="w-full px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
                          value={it.unit ?? ""}
                          onChange={(e) =>
                            updateItem(idx, { unit: e.target.value })
                          }
                        >
                          <option value="">—</option>
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-gray-600">
                          Unit $
                        </span>
                        <NumberInput
                          value={it.unit_price}
                          onChange={(n) => updateItem(idx, { unit_price: n })}
                          className="w-full px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-gray-600">
                          Int. $
                        </span>
                        <NumberInput
                          value={it.internal_cost ?? 0}
                          onChange={(n) =>
                            updateItem(idx, { internal_cost: n })
                          }
                          className="w-full px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
                        />
                      </label>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="text-sm text-gray-500">
                        Total: {formatMoney(it.quantity * it.unit_price)}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-red-600 hover:text-red-800"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addItem}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold"
              >
                <Plus className="h-4 w-4" />
                Add item
              </button>

              <div className="flex items-center justify-between">
                <span className="text-lg font-semibold">
                  Total: {formatMoney(total ?? 0)}
                </span>
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save
                </button>
              </div>
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}
