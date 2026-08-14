"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import EstimateLineItemEditor, {
  type EstimateLine,
  type CostCodeOption,
} from "@/components/EstimateLineItemEditor";
import { fetchPriorLineItems, type PriorItem } from "@/lib/estimateHistory";

function NewEstimateForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();

  const [jobs, setJobs] = useState<
    { id: string; name: string; customer_id: string | null }[]
  >([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  const [priorItems, setPriorItems] = useState<PriorItem[]>([]);
  const [items, setItems] = useState<EstimateLine[]>([
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
      if (profile?.role !== "office" && profile?.role !== "admin") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      const [{ data: jobRows }, { data: codeRows }] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, name, customer_id")
          .order("created_at", { ascending: false }),
        supabase.from("cost_codes").select("id, code, name").order("code"),
      ]);
      setJobs(jobRows ?? []);
      setCostCodes((codeRows as CostCodeOption[]) ?? []);
      setPriorItems(await fetchPriorLineItems());
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

    const selectedJob = jobs.find((j) => j.id === jobId);

    // Auto-generate a per-org estimate number (EST-0001…). RLS scopes the
    // read to this office user's org, so we find the max existing number and
    // add one. The partial unique index estimates_estimate_number_unique_org
    // can race on concurrent creates — on a 23505 we bump and retry (≤3).
    async function nextEstimateNumber(): Promise<string> {
      const { data: rows } = await supabase
        .from("estimates")
        .select("estimate_number")
        .not("estimate_number", "is", null);
      let max = 0;
      for (const r of rows ?? []) {
        const m = /^EST-(\d+)$/.exec(r.estimate_number ?? "");
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      return `EST-${String(max + 1).padStart(4, "0")}`;
    }

    let estimate: { id: string } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3 && !estimate; attempt++) {
      const estimateNumber = await nextEstimateNumber();
      const res = await supabase
        .from("estimates")
        .insert({
          job_id: jobId,
          title: title.trim() || null,
          note: note.trim() || null,
          customer_id: selectedJob?.customer_id ?? null,
          status: "draft",
          created_by: user.id,
          estimate_number: estimateNumber,
        })
        .select()
        .single();
      if (!res.error && res.data) {
        estimate = res.data as { id: string };
        break;
      }
      lastError = res.error;
      // 23505 = unique_violation on the estimate_number index → retry with a
      // fresh max. Anything else is a real error — stop.
      if (res.error?.code !== "23505") break;
    }

    if (!estimate) {
      const msg =
        lastError && typeof lastError === "object" && "message" in lastError
          ? String((lastError as { message: string }).message)
          : "unknown error";
      toast.error(`Failed to create estimate: ${msg}`);
      setLoading(false);
      return;
    }

    const lineInserts = validItems.map((item, idx) => ({
      estimate_id: estimate!.id,
      cost_code_id: item.cost_code_id ?? null,
      description: item.description.trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      section: item.section || null,
      internal_cost: item.internal_cost ?? null,
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
    // Carry ?job= forward so the new estimate's back button returns to the job
    // we were creating from (matches the back-to-job behavior on the list pages).
    const estimateHref = preselectedJob
      ? `/estimates/${estimate.id}?job=${preselectedJob}`
      : `/estimates/${estimate.id}`;
    setTimeout(() => router.push(estimateHref), 600);
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
          onClick={() =>
            router.push(preselectedJob ? `/jobs/${preselectedJob}` : "/estimates")
          }
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">
            {preselectedJob ? "Back to job" : "Estimates"}
          </span>
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
                priorItems={priorItems}
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