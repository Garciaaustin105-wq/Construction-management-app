"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2, Plus, Trash2, Tag } from "lucide-react";

type CostCode = {
  id: string;
  code: string;
  name: string;
  category: string | null;
};

const CATEGORIES = ["Labor", "Material", "Equipment", "Subcontract", "Other"];

export default function CostCodesManager({ orgId }: { orgId: string }) {
  const supabase = createClient();
  const toast = useToast();
  const [codes, setCodes] = useState<CostCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    // No synchronous setLoading(true) here — the initial state is already
    // `true`, so the mount effect calling load() triggers no setState in the
    // effect body (react-hooks/set-state-in-effect). Reloading after `add`
    // doesn't need a spinner (the Add button has its own `saving` state).
    const { data } = await supabase
      .from("cost_codes")
      .select("id, code, name, category")
      .order("code");
    setCodes((data as CostCode[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim();
    const n = name.trim();
    if (!c || !n) {
      toast.warning("Code and name are required");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("cost_codes")
      .insert({
        code: c,
        name: n,
        category: category || null,
        organization_id: orgId,
      })
      .select("id, code, name, category")
      .single();
    if (error) {
      toast.error(error.code === "23505" ? "That code already exists" : error.message);
    } else {
      toast.success("Cost code added");
      setCode("");
      setName("");
      setCategory("");
      await load();
    }
    setSaving(false);
  }

  async function remove(cc: CostCode) {
    if (!customConfirm(`Delete ${cc.code} — ${cc.name}? This removes it from the library.`)) return;
    const { error } = await supabase.from("cost_codes").delete().eq("id", cc.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Deleted");
      setCodes((prev) => prev.filter((x) => x.id !== cc.id));
    }
  }

  return (
    <section className="space-y-4">
      {/* Add form */}
      <form
        onSubmit={add}
        className="bg-white rounded-lg p-3 shadow-sm space-y-2"
      >
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            placeholder="Name (e.g. Rough-in electrical)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            <option value="">Category (optional)…</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </button>
        </div>
      </form>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : codes.length === 0 ? (
        <div className="bg-white rounded-lg p-6 text-center">
          <Tag className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No cost codes yet</p>
          <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
            Add codes like “100 · Rough-in”, “200 · Fixtures”, “300 · Trim-out”. Crew will tag time against these.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
          {codes.map((cc) => (
            <div key={cc.id} className="p-3 flex items-center gap-3">
              <span className="font-mono text-sm font-bold text-blue-700 w-14 flex-shrink-0">
                {cc.code}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{cc.name}</p>
                {cc.category && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                    {cc.category}
                  </span>
                )}
              </div>
              <button
                onClick={() => remove(cc)}
                className="text-red-600 p-2 rounded hover:bg-red-50 flex-shrink-0"
                title="Delete code"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}