"use client";
import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import type { SupabaseClient } from "@supabase/supabase-js";

function ChangeOrderForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();
  const [jobId, setJobId] = useState(preselectedJob);
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([]);
  const [costCodes, setCostCodes] = useState<{ id: string; code: string; name: string }[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(0);
  const [isCredit, setIsCredit] = useState(false);
  const [sourceRef, setSourceRef] = useState("");
  const [lines, setLines] = useState<{ cost_code_id: string; description: string; quantity: number; unit: string; unit_price: number }[]>([{ cost_code_id: "", description: "", quantity: 0, unit: "EA", unit_price: 0 }]);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => { (async () => {
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.push("/login"); return; }
    const { data: profile } = await supabase.from("profiles").select("role, organization_id").eq("id", user.id).single();
    if (!["office", "admin", "project_manager"].includes(profile?.role ?? "")) { router.push("/dashboard"); return; }
    setAuthorized(true);
    const [{ data: jobRows }, { data: costCodesRows }] = await Promise.all([
      supabase.from("jobs").select("id, name, type").eq("type", "construction").order("created_at", { ascending: false }),
      supabase.from("cost_codes").select("id, code, name").order("code"),
    ]);
    let jobsList = (jobRows ?? []) as { id: string; name: string; type: string }[];
    if (preselectedJob && !jobsList.some(x => x.id === preselectedJob)) {
      const { data: preJob } = await supabase.from("jobs").select("id, name, type").eq("id", preselectedJob).maybeSingle();
      if (preJob) jobsList = [preJob as { id: string; name: string; type: string }, ...jobsList];
    }
    setJobs(jobsList.map(j => ({ id: j.id, name: j.name })));
    setCostCodes(costCodesRows ?? []);
  })(); }, [router, preselectedJob]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId || !title.trim()) { toast.warning("Pick a job and enter a title"); return; }
    setLoading(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Not signed in"); setLoading(false); return; }
    const validLines = lines.filter(l => l.description.trim() || l.cost_code_id);
    let data: { id: string } | null = null;
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      const coNumber = await nextCONumber(supabase);
      const { data: inserted, error } = await supabase.from("change_orders").insert({
        job_id: jobId, title, description: description.trim() || null, reason: reason.trim() || null, amount: Number(amount) || 0, is_credit: isCredit, source_ref: sourceRef.trim() || null, co_number: coNumber, status: "draft", created_by: user.id
      }).select().single();
      if (error && error.code === "23505") { lastErr = error.message; continue; }
      if (error) { toast.error(`Failed: ${error.message}`); setLoading(false); return; }
      data = inserted;
    }
    if (!data) { toast.error(`Failed to generate a unique CO number: ${lastErr}`); setLoading(false); return; }
    const lineInserts = validLines.map((l, idx) => ({ change_order_id: data.id, cost_code_id: l.cost_code_id || null, description: l.description.trim() || null, quantity: l.quantity, unit_price: l.unit_price, position: idx }));
    const { error: linesError } = await supabase.from("change_order_lines").insert(lineInserts);
    if (linesError) toast.error(`Save failed: ${linesError.message}`);
    else { toast.success("Change order created"); setTimeout(() => router.push(preselectedJob ? `/change-orders/${data.id}?job=${preselectedJob}` : `/change-orders/${data.id}`), 600); }
    setLoading(false);
  }

  async function nextCONumber(supabase: SupabaseClient): Promise<string> {
    const { data } = await supabase
      .from("change_orders")
      .select("co_number")
      .order("co_number", { ascending: false })
      .limit(1);
    const last = (data ?? [])[0]?.co_number as string | undefined;
    let n = 0;
    if (last) {
      const m = last.match(/CO-(\d+)/);
      if (m) n = parseInt(m[1], 10);
    }
    return `CO-${(n + 1).toString().padStart(4, "0")}`;
  }

  function addLine() {
    setLines([...lines, { cost_code_id: "", description: "", quantity: 0, unit: "EA", unit_price: 0 }]);
  }

  function removeLine(index: number) {
    const newLines = [...lines];
    newLines.splice(index, 1);
    setLines(newLines);
  }

  if (!authorized) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>;
  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button onClick={() => router.push(preselectedJob ? `/jobs/${preselectedJob}` : "/change-orders")} className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]">
          <ArrowLeft className="w-4 h-4 flex-shrink-0" /><span className="truncate">{preselectedJob ? "Back to job" : "Change Orders"}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">New Change Order</h1>
        <div className="w-16" />
      </header>
      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <select value={jobId} onChange={e => setJobId(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base">
            <option value="">Select a job</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" required />
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" rows={3} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason" rows={2} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          <NumberInput value={amount} onChange={setAmount} placeholder="Amount" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          <label className="inline-flex items-center mt-2">
            <input type="checkbox" checked={isCredit} onChange={e => setIsCredit(e.target.checked)} className="form-checkbox h-4 w-4 text-blue-600 border-gray-300 rounded" />
            <span className="ml-2 text-sm text-gray-700">Is Credit</span>
          </label>
          <input type="text" value={sourceRef} onChange={e => setSourceRef(e.target.value)} placeholder="Source Ref" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
          <div className="space-y-4 mt-4">
            {lines.map((l, idx) => (
              <div key={idx} className="bg-white rounded-lg shadow-sm p-4 space-y-2">
                <select value={l.cost_code_id} onChange={e => {
                  const newLines = [...lines];
                  newLines[idx].cost_code_id = e.target.value;
                  setLines(newLines);
                }} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base">
                  <option value="">Select a cost code</option>
                  {costCodes.map(c => <option key={c.id} value={c.id}>{`${c.code} · ${c.name}`}</option>)}
                </select>
                <input type="text" value={l.description} onChange={e => {
                  const newLines = [...lines];
                  newLines[idx].description = e.target.value;
                  setLines(newLines);
                }} placeholder="Description" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                <NumberInput value={l.quantity} onChange={n => {
                  const newLines = [...lines];
                  newLines[idx].quantity = n;
                  setLines(newLines);
                }} placeholder="Quantity" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                <input type="text" value={l.unit} onChange={e => {
                  const newLines = [...lines];
                  newLines[idx].unit = e.target.value;
                  setLines(newLines);
                }} placeholder="Unit" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                <NumberInput value={l.unit_price} onChange={n => {
                  const newLines = [...lines];
                  newLines[idx].unit_price = n;
                  setLines(newLines);
                }} placeholder="Unit Price" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base" />
                <button type="button" onClick={() => removeLine(idx)} className="w-full bg-red-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-red-700 flex items-center justify-center gap-2">
                  Remove
                </button>
              </div>
            ))}
            <button type="button" onClick={addLine} className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" /> Add Line
            </button>
          </div>
          <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}{loading ? "Saving..." : "Save Draft"}
          </button>
        </form>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}><ChangeOrderForm /></Suspense>;
}