"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import StatusBadge from "@/components/StatusBadge";
import NumberInput from "@/components/NumberInput";
import { formatMoney } from "@/lib/money";
import { OFFICE_OR_PM } from "@/lib/roles";

type CO = {
  id: string;
  job_id: string;
  co_number: string | null;
  title: string;
  description: string | null;
  reason: string | null;
  amount: number;
  is_credit: boolean;
  source_ref: string | null;
  status: string;
  created_at: string;
  jobs: { name: string } | null;
};

type Line = {
  id?: string;
  cost_code_id: string;
  description: string;
  quantity: number;
  unit_price: number;
};
type CostCode = { id: string; code: string; name: string };

function ChangeOrderForm({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedJob = searchParams.get("job") ?? "";
  const toast = useToast();
  const [co, setCo] = useState<CO | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendNote, setSendNote] = useState("");

  useEffect(() => {
    (async () => {
      const { id: paramId } = await params;
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
      const role = profile?.role ?? "crew";
      if (!OFFICE_OR_PM.has(role)) {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      const [{ data: coRow }, { data: lineRows }, { data: ccRows }] = await Promise.all([
        supabase
          .from("change_orders")
          .select(
            "id, job_id, co_number, title, description, reason, amount, is_credit, source_ref, status, created_at, jobs(name)"
          )
          .eq("id", paramId)
          .single(),
        supabase
          .from("change_order_lines")
          .select("id, cost_code_id, description, quantity, unit_price, position")
          .eq("change_order_id", paramId)
          .order("position", { ascending: true }),
        supabase.from("cost_codes").select("id, code, name").order("code"),
      ]);

      if (!coRow) {
        toast.error("Change order not found");
        router.push("/change-orders");
        return;
      }
      setCo(coRow as unknown as CO);
      const loaded = ((lineRows ?? []) as unknown as {
        id: string;
        cost_code_id: string | null;
        description: string | null;
        quantity: number | string;
        unit_price: number | string;
      }[]).map((l) => ({
        id: l.id,
        cost_code_id: l.cost_code_id ?? "",
        description: l.description ?? "",
        quantity: Number(l.quantity) || 0,
        unit_price: Number(l.unit_price) || 0,
      }));
      setLines(
        loaded.length
          ? loaded
          : [{ cost_code_id: "", description: "", quantity: 0, unit_price: 0 }]
      );
      setCostCodes((ccRows ?? []) as unknown as CostCode[]);
    })();
  }, [params, router, toast]);

  async function save() {
    if (!co) return;
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("change_orders")
      .update({
        title: co.title,
        description: co.description || null,
        reason: co.reason || null,
        amount: Number(co.amount) || 0,
        is_credit: co.is_credit,
        source_ref: co.source_ref || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", co.id);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      setBusy(false);
      return;
    }
    // delete-all + reinsert lines
    await supabase.from("change_order_lines").delete().eq("change_order_id", co.id);
    const valid = lines.filter((l) => l.description.trim() || l.cost_code_id);
    if (valid.length) {
      const { error: lErr } = await supabase.from("change_order_lines").insert(
        valid.map((l, idx) => ({
          change_order_id: co.id,
          cost_code_id: l.cost_code_id || null,
          description: l.description.trim() || null,
          quantity: l.quantity,
          unit_price: l.unit_price,
          position: idx,
        }))
      );
      if (lErr) toast.error(`Lines save failed: ${lErr.message}`);
    }
    setBusy(false);
    toast.success("Saved");
    router.refresh();
  }

  async function submit() {
    if (!co) return;
    setBusy(true);
    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();
    const { error } = await supabase
      .from("change_orders")
      .update({ status: "submitted", updated_at: new Date().toISOString() })
      .eq("id", co.id);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setCo({ ...co, status: "submitted" });
    toast.success("Submitted for review");
  }

  async function sendToOwner() {
    if (!co) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/change-orders/${co.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: sendNote.trim() || null }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Send failed");
        return;
      }
      toast.success("Sent to owner");
      setCo({ ...co, status: "sent" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function reopen() {
    if (!co) return;
    setCo({ ...co, status: "draft" });
  }

  if (!authorized)
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  if (!co) return null;

  const backHref = preselectedJob ? `/jobs/${preselectedJob}` : "/change-orders";
  const editable = co.status === "draft" || co.status === "submitted" || co.status === "rejected";
  const lineTotal = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unit_price || 0), 0);

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push(backHref)}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{preselectedJob ? "Back to job" : "Change Orders"}</span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 truncate max-w-[40%]">
          {co.co_number ?? "Change Order"}
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4 space-y-4">
        <div className="bg-white rounded-lg shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-500">Status</span>
            <StatusBadge status={co.status} />
          </div>
          <p className="text-xs text-gray-500">
            {co.jobs?.name ?? ""}
            {` · ${new Date(co.created_at).toLocaleDateString()}`}
          </p>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Title</span>
            <input
              type="text"
              value={co.title}
              disabled={!editable}
              onChange={(e) => setCo({ ...co, title: e.target.value })}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Description</span>
            <textarea
              value={co.description ?? ""}
              disabled={!editable}
              onChange={(e) => setCo({ ...co, description: e.target.value })}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Reason</span>
            <textarea
              value={co.reason ?? ""}
              disabled={!editable}
              onChange={(e) => setCo({ ...co, reason: e.target.value })}
              rows={2}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Amount</span>
              <NumberInput
                value={co.amount}
                onChange={(n) => setCo({ ...co, amount: n })}
                disabled={!editable}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Source ref</span>
              <input
                type="text"
                value={co.source_ref ?? ""}
                disabled={!editable}
                onChange={(e) => setCo({ ...co, source_ref: e.target.value })}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
              />
            </label>
          </div>

          <label className="inline-flex items-center">
            <input
              type="checkbox"
              checked={co.is_credit}
              disabled={!editable}
              onChange={(e) => setCo({ ...co, is_credit: e.target.checked })}
              className="form-checkbox h-4 w-4 text-blue-600 border-gray-300 rounded"
            />
            <span className="ml-2 text-sm text-gray-700">Credit (reduces contract value)</span>
          </label>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase">Cost-code lines</h2>
            <span className="text-xs text-gray-500">{formatMoney(lineTotal)}</span>
          </div>
          <div className="space-y-3">
            {lines.map((l, idx) => (
              <div key={idx} className="bg-gray-50 rounded-lg p-3 space-y-2">
                <select
                  value={l.cost_code_id}
                  disabled={!editable}
                  onChange={(e) => {
                    const n = [...lines];
                    n[idx].cost_code_id = e.target.value;
                    setLines(n);
                  }}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100"
                >
                  <option value="">No cost code</option>
                  {costCodes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={l.description}
                  disabled={!editable}
                  placeholder="Line description"
                  onChange={(e) => {
                    const n = [...lines];
                    n[idx].description = e.target.value;
                    setLines(n);
                  }}
                  className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100"
                />
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput
                    value={l.quantity}
                    onChange={(n) => {
                      const arr = [...lines];
                      arr[idx].quantity = n;
                      setLines(arr);
                    }}
                    disabled={!editable}
                    placeholder="Qty"
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100"
                  />
                  <NumberInput
                    value={l.unit_price}
                    onChange={(n) => {
                      const arr = [...lines];
                      arr[idx].unit_price = n;
                      setLines(arr);
                    }}
                    disabled={!editable}
                    placeholder="Unit price"
                    className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100"
                  />
                </div>
                {editable && (
                  <button
                    type="button"
                    onClick={() =>
                      setLines(lines.filter((_, i) => i !== idx))
                    }
                    className="text-xs text-red-600 flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <button
                type="button"
                onClick={() =>
                  setLines([
                    ...lines,
                    { cost_code_id: "", description: "", quantity: 0, unit_price: 0 },
                  ])
                }
                className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Add line
              </button>
            )}
          </div>
        </div>

        {editable && (
          <div className="space-y-2">
            <button
              onClick={save}
              disabled={busy}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? "Saving..." : "Save changes"}
            </button>
            {co.status === "draft" && (
              <button
                onClick={submit}
                disabled={busy}
                className="w-full bg-white border border-gray-300 text-gray-800 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50"
              >
                Submit for internal review
              </button>
            )}
          </div>
        )}

        {(co.status === "submitted" || co.status === "draft") && (
          <div className="bg-white rounded-lg shadow-sm p-4 space-y-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase">Send to owner</h2>
            <textarea
              value={sendNote}
              onChange={(e) => setSendNote(e.target.value)}
              rows={2}
              placeholder="Optional note for the owner..."
              className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <button
              onClick={sendToOwner}
              disabled={busy}
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Send to owner
            </button>
          </div>
        )}

        {co.status === "sent" && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
            <p className="text-sm font-medium text-blue-800">Awaiting customer decision</p>
            <p className="text-xs text-blue-600 mt-1">
              The owner received a secure portal link. You will be notified when they decide.
            </p>
          </div>
        )}

        {co.status === "approved" && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <p className="text-sm font-medium text-green-800">Approved by customer</p>
            <p className="text-xs text-green-600 mt-1">
              Approved CO lines raise the budget on the job Budget tab.
            </p>
          </div>
        )}

        {co.status === "rejected" && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-2 text-center">
            <p className="text-sm font-medium text-red-800">Rejected by customer</p>
            <p className="text-xs text-red-600">
              Revise the details and resend, or void this change order.
            </p>
            <button
              onClick={reopen}
              className="text-sm text-red-700 underline"
            >
              Reopen as draft
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-gray-500">Loading...</p>
        </div>
      }
    >
      <ChangeOrderForm params={params} />
    </Suspense>
  );
}