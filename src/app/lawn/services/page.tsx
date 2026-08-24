"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import PageContainer from "@/components/PageContainer";
import { useToast } from "@/components/Toast";
import { Loader2, Plus, Scissors, Trash2, Pencil } from "lucide-react";

type Service = {
  id: string;
  name: string;
  default_price: number;
  active: boolean;
  /** Default visit length for this service, in minutes. Null = not set, which
   *  means a stop using it contributes no service time to route planning. */
  default_duration_minutes: number | null;
};

export default function LawnServicesPage() {
  const router = useRouter();
  const toast = useToast();

  const [services, setServices] = useState<Service[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  // Blank = "no default duration" (null), not zero — a service with no
  // recorded length must not tell the router the stop takes 0 minutes.
  const [duration, setDuration] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrice, setEditPrice] = useState("");
  const [editDuration, setEditDuration] = useState("");
  const [saving, setSaving] = useState(false);
  const [orgId, setOrgId] = useState<string>("");

  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from("lawn_services")
      .select("id, name, default_price, active, default_duration_minutes")
      .order("name");
    setServices((data as Service[]) ?? []);
  }

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, organization_id")
        .eq("id", user.id)
        .single();
      const role = profile?.role ?? "crew";
      if (role !== "office" && role !== "admin" && role !== "super_admin") {
        router.push("/dashboard");
        return;
      }
      setOrgId((profile?.organization_id as string) ?? "");
      setAuthorized(true);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "" -> null (unset). Otherwise a whole number of minutes >= 1.
  // Returns undefined to signal "invalid, already toasted".
  function parseDuration(raw: string): number | null | undefined {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1) {
      toast.warning("Duration must be a whole number of minutes (1 or more), or blank");
      return undefined;
    }
    return n;
  }

  async function addService() {
    if (!name.trim()) {
      toast.warning("Service name is required");
      return;
    }
    const p = parseFloat(price);
    if (isNaN(p) || p < 0) {
      toast.warning("Price must be 0 or more");
      return;
    }
    const dur = parseDuration(duration);
    if (dur === undefined) return;
    setAdding(true);
    const supabase = createClient();
    if (!orgId) {
      toast.error("Could not resolve your organization — reload and try again");
      setAdding(false);
      return;
    }
    const { data, error } = await supabase
      .from("lawn_services")
      .insert({
        name: name.trim(),
        default_price: p,
        active: true,
        default_duration_minutes: dur,
        organization_id: orgId,
      })
      .select("id, name, default_price, active, default_duration_minutes")
      .single();
    setAdding(false);
    if (error || !data) {
      toast.error(`Failed: ${error?.message ?? "error"}`);
      return;
    }
    setServices((prev) =>
      [...prev, data as Service].sort((a, b) => a.name.localeCompare(b.name))
    );
    setName("");
    setPrice("0");
    setDuration("");
    toast.success("Service added");
  }

  async function toggleActive(svc: Service) {
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("lawn_services")
      .update({ active: !svc.active })
      .eq("id", svc.id);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setServices((prev) =>
      prev.map((s) => (s.id === svc.id ? { ...s, active: !s.active } : s))
    );
  }

  async function removeService(svc: Service) {
    if (!confirm(`Delete "${svc.name}"? This removes it from the service dropdown.`)) return;
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.from("lawn_services").delete().eq("id", svc.id);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setServices((prev) => prev.filter((s) => s.id !== svc.id));
    toast.success("Service deleted");
  }

  function startEdit(svc: Service) {
    setEditingId(svc.id);
    setEditName(svc.name);
    setEditPrice(String(svc.default_price));
    setEditDuration(
      svc.default_duration_minutes === null ? "" : String(svc.default_duration_minutes)
    );
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditPrice("0");
    setEditDuration("");
  }

  async function saveEdit() {
    if (!editingId) return;
    if (!editName.trim()) {
      toast.warning("Service name is required");
      return;
    }
    const p = parseFloat(editPrice);
    if (isNaN(p) || p < 0) {
      toast.warning("Price must be 0 or more");
      return;
    }
    const dur = parseDuration(editDuration);
    if (dur === undefined) return;
    setSaving(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("lawn_services")
      .update({
        name: editName.trim(),
        default_price: p,
        default_duration_minutes: dur,
      })
      .eq("id", editingId)
      .select("id, name, default_price, active, default_duration_minutes")
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error(`Failed: ${error?.message ?? "error"}`);
      return;
    }
    setServices((prev) =>
      [...prev.map((s) => (s.id === editingId ? (data as Service) : s))].sort((a, b) => a.name.localeCompare(b.name))
    );
    setEditingId(null);
    setEditName("");
    setEditPrice("0");
    setEditDuration("");
    toast.success("Service updated");
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  return (
    <PageContainer title="Lawn Services" backHref="/lawn" backLabel="Lawn" maxWidth="list">
      {/* Add new service */}
      <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Plus className="w-4 h-4 text-green-600" />
          Add a service / price
        </h2>
        <input
          type="text"
          placeholder="e.g. Mow & edge"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
        />
        <input
          type="number"
          min={0}
          step="0.01"
          placeholder="Default price per visit"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
        />
        <input
          type="number"
          min={1}
          step="1"
          placeholder="Default duration in minutes (optional)"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
        />
        <button
          type="button"
          onClick={addService}
          disabled={adding}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add service
        </button>
      </div>

      {/* Service list */}
      <div>
        <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">
          Catalog ({services.length})
        </h2>
        {services.length === 0 ? (
          <div className="bg-white rounded-lg p-6 text-center">
            <Scissors className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-gray-700">No services yet</p>
            <p className="text-xs text-gray-500 mt-1">
              Add the services you offer (mow, fertilize, aeration…) with a default
              price. They appear in the job-create dropdown.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm divide-y">
            {services.map((s) => (
              <div key={s.id} className="p-3 flex items-center justify-between gap-2">
                {editingId === s.id ? (
                  <>
                    <div className="min-w-0 flex-1">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                      />
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={editPrice}
                        onChange={(e) => setEditPrice(e.target.value)}
                        className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                      />
                      <input
                        type="number"
                        min={1}
                        step="1"
                        placeholder="Duration (min)"
                        value={editDuration}
                        onChange={(e) => setEditDuration(e.target.value)}
                        className="block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={saving}
                        className="bg-green-600 text-white py-2 px-3 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="border border-gray-300 py-2 px-3 rounded-lg font-semibold text-sm active:bg-gray-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {s.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                        }).format(Number(s.default_price) || 0)}
                        /visit
                        {s.default_duration_minutes !== null &&
                          ` \u00b7 ${s.default_duration_minutes} min`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleActive(s)}
                        disabled={busy || saving}
                        className={`text-[10px] font-semibold px-2 py-1 rounded ${
                          s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {s.active ? "Active" : "Inactive"}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(s)}
                        disabled={busy || saving}
                        className="text-gray-400 active:text-blue-600 p-1"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeService(s)}
                        disabled={busy || saving}
                        className="text-gray-400 active:text-red-600 p-1"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  );
}