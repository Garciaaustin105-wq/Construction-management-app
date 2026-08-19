"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Plus, UserPlus } from "lucide-react";
import { useToast } from "@/components/Toast";
import EstimateLineItemEditor, {
  type EstimateLine,
  type CostCodeOption,
} from "@/components/EstimateLineItemEditor";
import { type ServiceOption } from "@/components/LineItemEditor";
import { fetchPriorLineItems, type PriorItem } from "@/lib/estimateHistory";
import { PIPELINE } from "@/lib/roles";

function NewEstimateForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();

  const [jobs, setJobs] = useState<
    { id: string; name: string; customer_id: string | null; type: string }[]
  >([]);
  const [jobId, setJobId] = useState(preselectedJob);
  // Lawn-services catalog — only passed to the line-item editor when the
  // selected job is a lawn job (deep-linked from the Lawn tab).
  const [services, setServices] = useState<ServiceOption[]>([]);
  // mode: "job" = link to a job (customer derived from the job); "customer" =
  // standalone estimate for a customer with no job profile (prospect → estimate).
  // A ?job= preselect forces job mode (you're creating from a job's context).
  // When opened directly (no ?job=) default to "customer" so the customer picker
  // is front-and-center for the prospect→estimate flow — otherwise the page
  // lands on a job picker with no way to select a brand-new customer.
  const [mode, setMode] = useState<"job" | "customer">(
    preselectedJob ? "job" : "customer"
  );
  const [customers, setCustomers] = useState<
    { id: string; name: string; contact_email: string | null }[]
  >([]);
  const [customerId, setCustomerId] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  // Inline "new customer" form (name + contact email) — reuses the
  // CustomersManager insert shape. Inserts with the caller's organization_id
  // (root table), refreshes the list, and auto-selects the new customer.
  const [showNewCust, setShowNewCust] = useState(false);
  const [newCustName, setNewCustName] = useState("");
  const [newCustEmail, setNewCustEmail] = useState("");
  const [addingCust, setAddingCust] = useState(false);
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
        .select("role, organization_id")
        .eq("id", user.id)
        .single();
      // Estimate authoring = the sales pipeline (sales/PM/office/admin/super_admin).
      // Was office/admin only, which locked PM out of authoring and excluded sales.
      if (!PIPELINE.has((profile?.role ?? "crew") as never)) {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);
      if (profile?.organization_id) setOrgId(profile.organization_id);

      const [{ data: jobRows }, { data: codeRows }, { data: servicesData }] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, name, customer_id, type")
          .eq("type", "construction")
          .order("created_at", { ascending: false }),
        supabase.from("cost_codes").select("id, code, name").order("code"),
        supabase
          .from("lawn_services")
          .select("id, name, default_price")
          .eq("active", true)
          .order("name"),
      ]);

      let jobsList = (jobRows as { id: string; name: string; customer_id: string | null; type: string }[]) ?? [];
      // When deep-linked from a lawn job (?job=), that job is type='lawn' and
      // isn't in the construction-only list — fetch it by id (any type) and
      // merge it in so it resolves + shows in the job picker.
      if (preselectedJob && !jobsList.some((x) => x.id === preselectedJob)) {
        const { data: preJob } = await supabase
          .from("jobs")
          .select("id, name, customer_id, type")
          .eq("id", preselectedJob)
          .maybeSingle();
        if (preJob) {
          jobsList = [
            preJob as { id: string; name: string; customer_id: string | null; type: string },
            ...jobsList,
          ];
        }
      }
      setJobs(jobsList);
      setCostCodes((codeRows as CostCodeOption[]) ?? []);
      setServices((servicesData as ServiceOption[]) ?? []);
      setPriorItems(await fetchPriorLineItems());
    })();
  }, [router, preselectedJob]);

  // Load the org's customers whenever standalone mode is active, and again when
  // the window regains focus — so a customer just created in the directory (or
  // another tab) appears in the picker without a manual reload. Customers are
  // only needed in customer mode (job mode derives the customer from the job),
  // so this effect is gated on mode === "customer".
  useEffect(() => {
    if (mode !== "customer") return;
    let cancelled = false;
    async function loadCustomers() {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const { data: custRows } = await supabase
        .from("customers")
        .select("id, name, contact_email")
        .order("name");
      if (!cancelled) {
        setCustomers(
          (custRows as {
            id: string;
            name: string;
            contact_email: string | null;
          }[]) ?? []
        );
      }
    }
    loadCustomers();
    function onFocus() {
      loadCustomers();
    }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [mode]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Job mode requires a job; standalone mode requires a customer. The
    // customer for a job estimate is derived from jobs.customer_id.
    if (mode === "job" && !jobId) {
      toast.warning("Pick a job");
      return;
    }
    if (mode === "customer" && !customerId) {
      toast.warning("Pick a customer");
      return;
    }
    const validItems = items.filter(
      (i) => i.description.trim() || i.cost_code_id
    );
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
      return;
    }
    if (!orgId) {
      toast.error("No organization on your profile — contact an admin.");
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

    const selectedJob = mode === "job" ? jobs.find((j) => j.id === jobId) : null;
    // customer_id: from the job (job mode) or the picked customer (standalone).
    const estimateCustomerId =
      mode === "job"
        ? selectedJob?.customer_id ?? null
        : customerId || null;
    // job_id is null in standalone mode. organization_id is ALWAYS passed —
    // trg_estimates_org stamps from the job when linked, else from this value
    // (so a job-less estimate still gets an org for RLS + numbering).
    const estimateJobId = mode === "job" ? jobId : null;

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
          job_id: estimateJobId,
          title: title.trim() || null,
          note: note.trim() || null,
          customer_id: estimateCustomerId,
          organization_id: orgId,
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
    // Carry ?job= forward (job mode only) so the new estimate's back button
    // returns to the job we were creating from. Standalone estimates have no
    // job, so they go straight to the estimate detail (back → /estimates).
    const estimateHref =
      mode === "job" && preselectedJob
        ? `/estimates/${estimate.id}?job=${preselectedJob}`
        : `/estimates/${estimate.id}`;
    setTimeout(() => router.push(estimateHref), 600);
  }

  // Inline "new customer" — inserts a customer (root table, app-supplied org)
  // then refreshes the list and auto-selects it. Mirrors CustomersManager.
  async function addCustomer() {
    if (!newCustName.trim()) {
      toast.warning("Customer name is required");
      return;
    }
    if (!orgId) {
      toast.error("No organization on your profile — contact an admin.");
      return;
    }
    setAddingCust(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: newCustName.trim(),
        contact_email: newCustEmail.trim() || null,
        organization_id: orgId,
      })
      .select("id, name, contact_email")
      .single();
    setAddingCust(false);
    if (error || !data) {
      toast.error(`Failed: ${error?.message ?? "error"}`);
      return;
    }
    setCustomers((prev) =>
      [...prev, data as { id: string; name: string; contact_email: string | null }].sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    );
    setCustomerId((data as { id: string }).id);
    setNewCustName("");
    setNewCustEmail("");
    setShowNewCust(false);
    toast.success("Customer added");
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
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

      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Mode toggle: link to a job, or quote a customer with no job yet.
              Hidden when deep-linked from a job (?job=) — the job context is
              fixed, so locking to job mode prevents dropping it accidentally. */}
          {!preselectedJob && (
            <div className="bg-white rounded-lg p-1 grid grid-cols-2 gap-1 shadow-sm">
              <button
                type="button"
                onClick={() => setMode("job")}
                className={`py-2.5 rounded-md text-sm font-semibold ${
                  mode === "job"
                    ? "bg-blue-600 text-white"
                    : "text-gray-600"
                }`}
              >
                Linked to a job
              </button>
              <button
                type="button"
                onClick={() => setMode("customer")}
                className={`py-2.5 rounded-md text-sm font-semibold ${
                  mode === "customer"
                    ? "bg-blue-600 text-white"
                    : "text-gray-600"
                }`}
              >
                Customer only
              </button>
            </div>
          )}

          {mode === "job" ? (
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
          ) : (
            <div className="space-y-2">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Customer *
                </span>
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  required
                  className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
                >
                  <option value="">Select customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.contact_email ? ` · ${c.contact_email}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setShowNewCust((v) => !v)}
                className="text-sm text-blue-600 flex items-center gap-1"
              >
                <UserPlus className="w-4 h-4" />
                {showNewCust ? "Cancel new customer" : "New customer"}
              </button>
              {showNewCust && (
                <div className="bg-white rounded-lg p-3 shadow-sm space-y-2">
                  <input
                    type="text"
                    placeholder="Customer / company name *"
                    value={newCustName}
                    onChange={(e) => setNewCustName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <input
                    type="email"
                    placeholder="Contact email (used to send the estimate)"
                    value={newCustEmail}
                    onChange={(e) => setNewCustEmail(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <button
                    type="button"
                    onClick={addCustomer}
                    disabled={addingCust}
                    className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {addingCust ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                    Add customer
                  </button>
                </div>
              )}
              <p className="text-xs text-gray-400">
                Standalone estimates have no job — the customer&rsquo;s address
                (if any) shows as the project address on the document.
              </p>
            </div>
          )}

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
                services={
                  mode === "job" &&
                  jobs.find((j) => j.id === jobId)?.type === "lawn"
                    ? services
                    : undefined
                }
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