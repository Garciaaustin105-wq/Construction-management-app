"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { createClient } from "@/lib/supabase/client";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";

// Construction-job creator (office/admin). Recurring lawn service used to live
// here as a toggle — it's been lifted into a dedicated /lawn/new creator so
// lawn jobs are created inside the Lawn tab and stay isolated (type='lawn').
// This page is now construction-only: a normal one-off job. jobs.type defaults
// to 'construction' in the DB, so this insert doesn't send it (stays correct
// whether or not the jobs_type.sql migration has run yet — and keeps working
// during the deploy window).

export default function NewProjectPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [crew, setCrew] = useState<{ id: string; full_name: string | null; email: string }[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [orgId, setOrgId] = useState<string>("");
  const toast = useToast();

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles").select("role, organization_id").eq("id", user.id).single();
      const role = profile?.role ?? "crew";
      // office + admin create jobs in their own org; super_admin (no org) uses
      // the platform view instead.
      if (isSuperAdmin(role) || !isOfficeLike(role) || !profile?.organization_id) {
        router.push("/dashboard");
        return;
      }
      setOrgId(profile.organization_id as string);
      const [{ data: custs }, { data: crews }] = await Promise.all([
        supabase.from("customers").select("id, name").order("name"),
        supabase.from("profiles").select("id, full_name, email").in("role", ["crew", "superintendent"]).order("full_name"),
      ]);
      setCustomers(custs ?? []);
      setCrew(crews ?? []);
    })();
  }, [router]);

  function toggleCrew(id: string) {
    setAssigned((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }
    const { data, error } = await supabase.from("jobs").insert({
      customer_id: customerId || null,
      name,
      address: address || null,
      description: description || null,
      status: "scheduled",
      scheduled_start: scheduledStart || null,
      scheduled_end: scheduledEnd || null,
      assigned_crew: assigned,
      organization_id: orgId,
    }).select().single();
    if (error) {
      toast.error(`Failed to create: ${error.message}`);
      setLoading(false);
      return;
    }

    toast.success("Project created");
    setTimeout(() => router.push(`/jobs/${data.id}`), 600);
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          New Project
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Project Name *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="Office Building Cat6 Install"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Customer</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            >
              <option value="">— Select customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Address</span>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="123 Main St, City"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Description / Scope</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              placeholder="40 Cat6 drops, terminate and test..."
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Start</span>
              <input
                type="date"
                value={scheduledStart}
                onChange={(e) => setScheduledStart(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">End</span>
              <input
                type="date"
                value={scheduledEnd}
                onChange={(e) => setScheduledEnd(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
          </div>

          {crew.length > 0 && (
            <div>
              <span className="text-sm font-medium text-gray-700">Assign Crew</span>
              <div className="mt-2 space-y-2">
                {crew.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 active:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={assigned.includes(c.id)}
                      onChange={() => toggleCrew(c.id)}
                      className="w-5 h-5"
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {c.full_name ?? c.email}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{c.email}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}
            {loading ? "Creating..." : "Create Project"}
          </button>
        </form>
      </main>

    </div>
  );
}