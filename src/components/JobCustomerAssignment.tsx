"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Building2, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

// Set/change the customer linked to an EXISTING job. Job creation
// (/admin/projects/new) already lets office pick a customer at insert time
// (jobs.customer_id) — but until now there was no way to attach or change the
// customer afterward, so a job created without one (or one that needs
// reassigning) had no path to "connect" to a customer. Mirrors the "Assign
// crew" select on the lawn visit page: saves immediately on change, no
// separate Save button. jobs UPDATE RLS is tier_office_or_pm (see
// multi_tenancy_b.sql), matching the OFFICE_OR_PM gate the parent page uses
// to render this at all, so a plain client update (not an RPC) is sufficient
// here — unlike assigned_crew, which goes through the assign_job_crew RPC.
export default function JobCustomerAssignment({
  jobId,
  initialCustomerId,
  customers,
}: {
  jobId: string;
  initialCustomerId: string | null;
  customers: { id: string; name: string }[];
}) {
  const [customerId, setCustomerId] = useState(initialCustomerId ?? "");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  async function save(next: string) {
    if (next === (initialCustomerId ?? "")) return;
    setSaving(true);

    // Block reassignment once the job has invoices or estimates. Those carry
    // their own independent customer_id (set at creation, never re-derived
    // from the job), so silently repointing jobs.customer_id here would leave
    // the job showing one customer while its money records still show
    // another — a real mismatch, not just a display issue. Safe to skip this
    // check for a job with no financial records yet (nothing to desync).
    const [{ count: invoiceCount, error: invErr }, { count: estimateCount, error: estErr }] =
      await Promise.all([
        supabase
          .from("invoices")
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId),
        supabase
          .from("estimates")
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId),
      ]);
    if (invErr || estErr) {
      setSaving(false);
      toast.error(`Failed: ${(invErr ?? estErr)?.message}`);
      return;
    }
    if ((invoiceCount ?? 0) > 0 || (estimateCount ?? 0) > 0) {
      setSaving(false);
      toast.error(
        "Can't change the customer — this job already has invoices or estimates. Update the customer on those directly instead."
      );
      return;
    }

    setCustomerId(next);
    const { error } = await supabase
      .from("jobs")
      .update({ customer_id: next || null })
      .eq("id", jobId);
    setSaving(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      // Roll back the optimistic selection so the dropdown reflects reality.
      setCustomerId(initialCustomerId ?? "");
      return;
    }
    toast.success(next ? "Customer linked" : "Customer removed");
    router.refresh();
  }

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <Building2 className="w-5 h-5" />
        Customer
      </h2>
      <label className="block">
        <span className="text-sm font-medium text-gray-700 sr-only">Customer</span>
        <div className="relative">
          <select
            value={customerId}
            onChange={(e) => save(e.target.value)}
            disabled={saving}
            className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base disabled:opacity-50"
          >
            <option value="">— No customer linked —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {saving && (
            <Loader2 className="w-4 h-4 animate-spin text-gray-400 absolute right-8 top-1/2 -translate-y-1/2 pointer-events-none" />
          )}
        </div>
      </label>
      {customers.length === 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded mt-2">
          No customers yet — add one in Customers first.
        </p>
      )}
    </section>
  );
}
