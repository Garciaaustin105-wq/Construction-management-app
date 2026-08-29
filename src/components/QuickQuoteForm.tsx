"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { isLawn } from "@/lib/variant";

/**
 * QuickQuoteForm – the fast intake step for a new prospect. Collects just
 * enough to create the customer + a draft estimate, then hands off to the
 * real estimate editor (/estimates/[id], which defaults to its edit tab).
 * That's where line items, cost codes, and — on the lawn variant — the
 * property measurement map actually live; this form used to duplicate a
 * bare manual line-item entry here too, but that meant "Quick quote" never
 * actually measured anything. Address is required (not just optional) so
 * the map has something to center on the moment the user lands there.
 */
export default function QuickQuoteForm({
  orgId,
}: {
  orgId: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");

  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.warning("Name is required");
      return;
    }
    if (isLawn() && !address.trim()) {
      toast.warning("Address is required — it's what centers the measurement map");
      return;
    }
    setLoading(true);

    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }

    const { data: custData, error: custErr } = await supabase
      .from("customers")
      .insert({
        name: name.trim(),
        phone: phone || null,
        contact_email: email || null,
        address: address || null,
        organization_id: orgId,
      })
      .select("id")
      .single();

    if (custErr || !custData) {
      toast.error(`Failed to create customer: ${custErr?.message ?? "unknown"}`);
      setLoading(false);
      return;
    }

    const customerId = custData.id;

    const nextEstimateNumber = async () => {
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
    };

    let estimate: { id: string } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3 && !estimate; attempt++) {
      const estimateNumber = await nextEstimateNumber();
      const res = await supabase
        .from("estimates")
        .insert({
          job_id: null,
          // null, not "Quick quote" -- the estimates list falls back to the
          // customer's name when title is unset (r.title || r.jobName), so a
          // hardcoded title here meant every quick-quote estimate showed
          // "Quick quote" in the list instead of who it's actually for.
          title: null,
          note: null,
          customer_id: customerId,
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

    toast.success("Estimate started — add line items or measure the property next");
    setTimeout(() => router.push(`/estimates/${estimate.id}`), 600);
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Name *</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Phone</span>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Address{isLawn() ? " *" : ""}
          </span>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required={isLawn()}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
          {isLawn() && (
            <span className="mt-1 block text-xs text-gray-500">
              Centers the measurement map on the next screen.
            </span>
          )}
        </label>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-5 h-5 animate-spin" />}
        {loading ? "Starting…" : "Start estimate"}
      </button>
    </form>
  );
}
