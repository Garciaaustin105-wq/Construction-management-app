"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, FileText, Plus } from "lucide-react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import EstimateLineItemEditor, {
  type EstimateLine,
  type CostCodeOption,
} from "@/components/EstimateLineItemEditor";
import { fetchPriorLineItems, type PriorItem } from "@/lib/estimateHistory";

type Estimate = {
  id: string;
  job_id: string;
  title: string | null;
  status: string;
  note: string | null;
  created_at: string;
  jobs: { name: string } | null;
};

type LineRow = {
  id: string;
  cost_code_id: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  converted: "Converted to quote",
  rejected: "Rejected",
};

export default function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [id, setId] = useState<string>("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [items, setItems] = useState<EstimateLine[]>([]);
  const [costCodes, setCostCodes] = useState<CostCodeOption[]>([]);
  const [priorItems, setPriorItems] = useState<PriorItem[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    (async () => {
      const { id: paramId } = await params;
      setId(paramId);
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

      const [{ data: est }, { data: codeRows }] = await Promise.all([
        supabase
          .from("estimates")
          .select("id, job_id, title, status, note, created_at, jobs(name)")
          .eq("id", paramId)
          .single(),
        supabase.from("cost_codes").select("id, code, name").order("code"),
      ]);
      setCostCodes((codeRows as CostCodeOption[]) ?? []);
      setPriorItems(await fetchPriorLineItems());

      if (!est) {
        toast.error("Estimate not found");
        router.push("/estimates");
        return;
      }
      setEstimate(est as unknown as Estimate);

      const { data: lineRows } = await supabase
        .from("estimate_line_items")
        .select("id, cost_code_id, description, quantity, unit, unit_price")
        .eq("estimate_id", paramId)
        .order("position");
      setItems(
        (lineRows as LineRow[] | null ?? []).map((r) => ({
          cost_code_id: r.cost_code_id,
          description: r.description ?? "",
          quantity: Number(r.quantity) || 0,
          unit: r.unit ?? "EA",
          unit_price: Number(r.unit_price) || 0,
        }))
      );
      setLoading(false);
    })();
  }, [params, router, toast]);

  async function saveLines() {
    if (!id) return;
    const validItems = items.filter((i) => i.description.trim() || i.cost_code_id);
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
      return;
    }
    setSaving(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();

    // Replace all line items (simplest correct sync: delete + reinsert with
    // fresh positions). Office-only RLS guards both operations.
    await supabase.from("estimate_line_items").delete().eq("estimate_id", id);
    const lineInserts = validItems.map((item, idx) => ({
      estimate_id: id,
      cost_code_id: item.cost_code_id ?? null,
      description: item.description.trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      position: idx,
    }));
    const { error } = await supabase.from("estimate_line_items").insert(lineInserts);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
    } else {
      toast.success("Estimate saved");
    }
    setSaving(false);
  }

  async function convertToQuote() {
    if (!id) return;
    const validItems = items.filter((i) => i.description.trim() || i.cost_code_id);
    if (validItems.length === 0) {
      toast.warning("Add at least one line item before converting");
      return;
    }
    if (!confirm("Convert this estimate to a draft quote? You can then review and send it to the customer.")) return;
    setConverting(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { data, error } = await supabase.rpc("convert_estimate_to_quote", {
      p_estimate_id: id,
    });
    if (error || !data) {
      toast.error(`Convert failed: ${error?.message ?? "unknown error"}`);
      setConverting(false);
      return;
    }
    toast.success("Converted to quote");
    setTimeout(() => router.push(`/quotes/${data}`), 600);
  }

  if (!authorized || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (!estimate) return null;

  const readOnly = estimate.status === "converted";

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
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[55%]">
          {estimate.title || "Estimate"}
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4 space-y-4">
        <section className="bg-white rounded-lg p-4 shadow-sm space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Link
              href={`/jobs/${estimate.job_id}`}
              className="text-sm font-semibold text-blue-700 truncate"
            >
              {estimate.jobs?.name ?? "—"}
            </Link>
            <span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-700 flex-shrink-0">
              {STATUS_LABEL[estimate.status] ?? estimate.status}
            </span>
          </div>
          {estimate.note && (
            <p className="text-sm text-gray-600 pt-1 border-t border-gray-100 mt-2">
              {estimate.note}
            </p>
          )}
          <p className="text-xs text-gray-400">
            {new Date(estimate.created_at).toLocaleDateString()}
          </p>
        </section>

        {readOnly && (
          <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-3">
            This estimate was converted to a quote — line items are read-only.
          </p>
        )}

        <div>
          <span className="text-sm font-medium text-gray-700">Line items</span>
          <div className="mt-2">
            <EstimateLineItemEditor
              items={items}
              onChange={setItems}
              costCodes={costCodes}
              priorItems={priorItems}
              disabled={readOnly}
            />
          </div>
        </div>

        {!readOnly && (
          <button
            onClick={saveLines}
            disabled={saving}
            className="w-full bg-white border border-gray-300 text-gray-900 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {saving ? "Saving..." : "Save changes"}
          </button>
        )}

        {!readOnly && (
          <button
            onClick={convertToQuote}
            disabled={converting}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {converting ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
            {converting ? "Converting..." : "Convert to Quote"}
          </button>
        )}

        {readOnly && (
          <Link
            href="/estimates"
            className="block text-center text-sm text-gray-500 py-2"
          >
            ← Back to estimates
          </Link>
        )}
      </main>
    </div>
  );
}