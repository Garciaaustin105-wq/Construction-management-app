"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import EstimateLineItemEditor, {
  type EstimateLine,
  type CostCodeOption,
} from "@/components/EstimateLineItemEditor";

function NewEstimateForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();

  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  const [items, setItems] = useState<EstimateLine[]>([
    { cost_code_id: null, description: "", quantity: 1, unit: "EA", unit_price: 0 },
  ]);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    (async () => {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (profile?.role !== "office") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      const [{ data: jobRows }, { data: codeRows }] = await Promise.all([
        supabase.from("jobs").select("id, name").order("created_at", { ascending: false }),
        supabase.from("cost_codes").select("id, code, name").order("code"),
      ]);
      setJobs(jobRows ?? []);
      setCostCodes((codeRows as CostCodeOption[]) ?? []);
    })();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId) {
      toast.warning("Pick a job");
      return;
    }
    const validItems = items.filter(
      (i) => i.description.trim() || i.cost_code_id
    );
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
      return;
    }
    setLoading(true);

    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }

    const { data: estimate, error } = await supabase
      .from("estimates")
      .insert({
        job_id: jobId,
        title: title.trim() || null,
        note: note.trim() || null,
        status: "draft",
        created_by: user.id,
      })
      .select()
      .single();

    if (error || !estimate) {
      toast.error(`Failed to create estimate: ${error?.message ?? "unknown error"}`);
      setLoading(false);
      return;
    }

    const lineInserts = validItems.map((item, idx) => ({
      estimate_id: estimate.id,
      cost_code_id: item.cost_code_id ?? null,
      description: item.description.trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      position: idx,
    }));

    const { error: linesError } = await supabase
      .from("estimate_line_items")
      .insert(lineInserts);

    if (linesError) {
      toast.error(`Lines failed: ${linesError.message}`);
      setLoading(false);
      return;
    }

    toast.success("Estimate created");
    setTimeout(() => router.push(`/estimates/${estimate.id}`), 600);
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/estimates")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Estimates
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          New Estimate
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Job *</span>
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            >
              <option value="">Select job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Title (optional)</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Site work & electrical estimate"
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <div>
            <span className="text-sm font-medium text-gray-700">Line items</span>
            <div className="mt-2">
              <EstimateLineItemEditor
                items={items}
                onChange={setItems}
                costCodes={costCodes}
              />
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Internal note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Notes for the office team (not shown to the customer)"
              rows={2}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}
            {loading ? "Saving..." : "Save as Draft"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function NewEstimatePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-gray-500">Loading...</p>
        </div>
      }
    >
      <NewEstimateForm />
    </Suspense>
  );
}