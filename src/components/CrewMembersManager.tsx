"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2, Plus, Trash2, Users, Pencil, Check, X } from "lucide-react";

type CrewMember = {
  id: string;
  name: string;
  phone: string | null;
  trade: string | null;
  user_id: string | null; // null = scheduling-only (no app login)
};

export default function CrewMembersManager({ orgId }: { orgId: string }) {
  const supabase = createClient();
  const toast = useToast();
  const [members, setMembers] = useState<CrewMember[]>([]);
  const [loading, setLoading] = useState(true);

  // Add form
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [trade, setTrade] = useState("");
  const [saving, setSaving] = useState(false);

  // Inline edit (scheduling-only rows only)
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editTrade, setEditTrade] = useState("");

  async function load() {
    const { data } = await supabase
      .from("crew_members")
      .select("id, name, phone, trade, user_id")
      .order("name");
    setMembers((data as CrewMember[]) ?? []);
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
    const n = name.trim();
    if (!n) {
      toast.warning("Name is required");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("crew_members")
      .insert({
        name: n,
        phone: phone.trim() || null,
        trade: trade.trim() || null,
        organization_id: orgId,
      })
      .select("id, name, phone, trade, user_id")
      .single();
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Crew member added");
      setName("");
      setPhone("");
      setTrade("");
      await load();
    }
    setSaving(false);
  }

  function startEdit(m: CrewMember) {
    setEditId(m.id);
    setEditName(m.name);
    setEditPhone(m.phone ?? "");
    setEditTrade(m.trade ?? "");
  }

  async function saveEdit(id: string) {
    const n = editName.trim();
    if (!n) {
      toast.warning("Name is required");
      return;
    }
    const { error } = await supabase
      .from("crew_members")
      .update({
        name: n,
        phone: editPhone.trim() || null,
        trade: editTrade.trim() || null,
      })
      .eq("id", id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Saved");
      setEditId(null);
      await load();
    }
  }

  async function remove(m: CrewMember) {
    const linked = !!m.user_id;
    const msg = linked
      ? `Remove ${m.name} from the crew pool? Their assigned visits will be unassigned. The app-user account stays in Users.`
      : `Delete ${m.name}? This removes the scheduling-only crew member.`;
    if (!confirm(msg)) return;
    const { error } = await supabase.from("crew_members").delete().eq("id", m.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Removed");
      setMembers((prev) => prev.filter((x) => x.id !== m.id));
    }
  }

  return (
    <section className="space-y-4">
      {/* Add scheduling-only crew member */}
      <form
        onSubmit={add}
        className="bg-white rounded-lg p-3 shadow-sm space-y-2"
      >
        <p className="text-xs text-gray-500">
          Add a crew member for scheduling who won&rsquo;t use the app. App-user
          crew are added automatically from <span className="font-medium">Users</span>.
        </p>
        <input
          type="text"
          placeholder="Name (e.g. Mike Rodriguez)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <div className="flex gap-2">
          <input
            type="tel"
            placeholder="Phone (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            placeholder="Trade (optional)"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
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

      {/* Roster */}
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : members.length === 0 ? (
        <div className="bg-white rounded-lg p-6 text-center">
          <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No crew members yet</p>
          <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
            Add scheduling-only crew above, or add a crew-role user in Users — they&rsquo;ll appear here automatically.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
          {members.map((m) => {
            const linked = !!m.user_id;
            const editing = editId === m.id;
            return (
              <div key={m.id} className="p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  {editing ? (
                    <div className="space-y-1">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                      />
                      <div className="flex gap-2">
                        <input
                          type="tel"
                          placeholder="Phone"
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-sm"
                        />
                        <input
                          type="text"
                          placeholder="Trade"
                          value={editTrade}
                          onChange={(e) => setEditTrade(e.target.value)}
                          className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-sm"
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-gray-900 truncate">{m.name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {linked
                          ? "App user — has app login"
                          : "Scheduling only — no app login"}
                        {m.trade ? ` · ${m.trade}` : ""}
                        {m.phone ? ` · ${m.phone}` : ""}
                      </p>
                    </>
                  )}
                </div>
                {editing ? (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => saveEdit(m.id)}
                      className="text-green-600 p-2 rounded hover:bg-green-50"
                      title="Save"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      className="text-gray-500 p-2 rounded hover:bg-gray-100"
                      title="Cancel"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!linked && (
                      <button
                        onClick={() => startEdit(m)}
                        className="text-gray-500 p-2 rounded hover:bg-gray-100"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => remove(m)}
                      className="text-red-600 p-2 rounded hover:bg-red-50"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-gray-400">
        Scheduling-only crew never receive a login. Assign them to visits from a
        visit&rsquo;s &ldquo;Assign crew&rdquo; dropdown or the Route Planner.
      </p>
    </section>
  );
}