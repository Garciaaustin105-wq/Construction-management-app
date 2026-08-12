"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2 } from "lucide-react";

// Office-only inline control to set a job's blended labor rate ($/hr), used by
// the budget-vs-actual report to convert crew time-entry hours into a labor
// dollar cost. UPDATE on jobs is office-only via RLS.
export default function JobLaborRateControl({
  jobId,
  initialRate,
}: {
  jobId: string;
  initialRate: number | null;
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();
  const [rate, setRate] = useState<string>(
    initialRate != null ? String(initialRate) : ""
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    const value = rate.trim() === "" ? null : Number(rate);
    if (rate.trim() !== "" && (Number.isNaN(value) || (value as number) < 0)) {
      toast.warning("Enter a valid rate");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("jobs")
      .update({ labor_rate: value })
      .eq("id", jobId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success(value == null ? "Labor rate cleared" : "Labor rate saved");
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 whitespace-nowrap">Labor rate $/hr</span>
      <input
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        onBlur={save}
        placeholder="e.g. 65"
        className="w-24 px-2 py-1.5 border border-gray-300 rounded text-xs"
      />
      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
    </div>
  );
}