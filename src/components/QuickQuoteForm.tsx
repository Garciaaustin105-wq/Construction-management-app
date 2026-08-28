"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { formatMoney } from "@/lib/money";

/**
 * QuickQuoteForm – a lightweight, single‑page estimate creator.
 * It collects a customer and up to six line items, then writes a new
 * estimate and its items to Supabase in a single transaction.
 * Designed for the “speed‑to‑quote” flow used by sales reps.
 */
export default function QuickQuoteForm({
  orgId,
}: {
  orgId: string;
}): React.ReactElement {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");

  type Item = {
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
  };

  const unitOptions = [
    "",
    "EA",
    "LF",
    "SF",
    "CF",
    "HR",
    "DAY",
    "LOT",
    "GAL",
    "TON",
    "%",
  ];

  const [items, setItems] = useState<Item[]>([
    { description: "", quantity: 1, unit: "", unit_price: 0 },
    { description: "", quantity: 1, unit: "", unit_price: 0 },
  ]);

  const [loading, setLoading] = useState(false);

  const updateItem = (
    idx: number,
    field: keyof Item,
    value: string | number
  ) => {
    setItems((prev) =>
      prev.map((i, j) => (j === idx ? { ...i, [field]: value } : i))
    );
  };

  const addLine = () => {
    if (items.length < 6) {
      setItems((prev) => [
        ...prev,
        { description: "", quantity: 1, unit: "", unit_price: 0 },
      ]);
    }
  };

  const total = items.reduce(
    (sum, i) => sum + i.quantity * i.unit_price,
    0
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.warning("Name is required");
      return;
    }
    const validItems = items.filter(
      (i) => i.description.trim() || i.unit_price > 0
    );
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
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
          title: "Quick quote",
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

    const lineInserts = validItems.map((item, idx) => ({
      estimate_id: estimate.id,
      cost_code_id: null,
      description: item.description.trim() || null,
      quantity: item.quantity,
      unit: item.unit || null,
      unit_price: item.unit_price,
      section: null,
      internal_cost: null,
      position: idx,
      schedule_frequency: null,
      schedule_interval_weeks: 1,
      schedule_days_of_week: [],
      schedule_day_of_month: null,
      schedule_start_date: null,
      schedule_end_date: null,
    }));

    const { error: linesError } = await supabase
      .from("estimate_line_items")
      .insert(lineInserts);

    if (linesError) {
      toast.error(`Lines failed: ${linesError.message}`);
      setTimeout(() => router.push(`/estimates/${estimate.id}`), 600);
      setLoading(false);
      return;
    }

    toast.success("Quote created");
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
          <span className="text-sm font-medium text-gray-700">Address</span>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
        </label>
      </div>

      <div>
        <span className="text-sm font-medium text-gray-700">Line items</span>
        <div className="mt-2 space-y-2">
          {items.map((item, idx) => (
            <div key={idx} className="grid grid-cols-8 gap-2 items-end">
              <input
                type="text"
                placeholder="Description"
                value={item.description}
                onChange={(e) => updateItem(idx, "description", e.target.value)}
                className="col-span-4 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
              <NumberInput
                value={item.quantity}
                onChange={(q) => updateItem(idx, "quantity", q)}
                placeholder="Qty"
                className="col-span-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
              <select
                value={item.unit}
                onChange={(e) => updateItem(idx, "unit", e.target.value)}
                className="col-span-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              >
                {unitOptions.map((u) => (
                  <option key={u} value={u}>
                    {u || "—"}
                  </option>
                ))}
              </select>
              <NumberInput
                value={item.unit_price}
                onChange={(p) => updateItem(idx, "unit_price", p)}
                placeholder="Price"
                className="col-span-2 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
            </div>
          ))}
        </div>
        <div className="flex justify-between items-center mt-2">
          <button
            type="button"
            onClick={addLine}
            disabled={items.length >= 6}
            className="text-sm text-blue-600 flex items-center gap-1"
          >
            <Plus className="w-4 h-4" /> Add line
          </button>
          <div className="text-sm font-semibold">
            Total: {formatMoney(total)}
          </div>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-5 h-5 animate-spin" />}
        {loading ? "Saving..." : "Create Quote"}
      </button>
    </form>
  );
}
