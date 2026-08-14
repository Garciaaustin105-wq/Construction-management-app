"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { useToast } from "@/components/Toast";
import { Loader2, Plus, Scissors, Trash2 } from "lucide-react";

type Service = {
  id: string;
  name: string;
  default_price: number;
  active: boolean;
};

export default function LawnServicesPage() {
  const router = useRouter();
  const toast = useToast();

  const [services, setServices] = useState<Service[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("0");
  const [adding, setAdding] = useState(false);

  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from("lawn_services")
      .select("id, name, default_price, active")
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
      setAuthorized(true);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setAdding(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("lawn_services")
      .insert({
        name: name.trim(),
        default_price: p,
        active: true,
      })
      .select("id, name, default_price, active")
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
    if (!customConfirm(`Delete "${svc.name}"? This removes it from the service dropdown.`)) return;
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

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Lawn Services" backHref="/lawn" backLabel="Lawn" />

      <main className="max-w-md mx-auto p-4 space-y-4">
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
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleActive(s)}
                      disabled={busy}
                      className={`text-[10px] font-semibold px-2 py-1 rounded ${
                        s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {s.active ? "Active" : "Inactive"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeService(s)}
                      disabled={busy}
                      className="text-gray-400 active:text-red-600 p-1"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}