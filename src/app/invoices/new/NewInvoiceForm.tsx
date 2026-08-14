"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import LineItemEditor, { LineItem } from "@/components/LineItemEditor";
import { ArrowLeft, Loader2 } from "lucide-react";

export default function NewInvoiceForm({
  preselectedJobId,
}: {
  preselectedJobId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [authorized, setAuthorized] = useState(false);
  const [jobs, setJobs] = useState<
    Array<{ id: string; name: string; customer_id: string | null }>
  >([]);
  const [customers, setCustomers] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [jobId, setJobId] = useState<string>(preselectedJobId);
  const [customerId, setCustomerId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [items, setItems] = useState<LineItem[]>([
    { description: "", quantity: 1, unit_price: 0 },
  ]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
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
      if (profile?.role !== "office" && profile?.role !== "admin" && profile?.role !== "project_manager") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);

      const [{ data: jobsData }, { data: customersData }] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, name, customer_id")
          .order("created_at", { ascending: false }),
        supabase
          .from("customers")
          .select("id, name")
          .order("name"),
      ]);
      setJobs(jobsData ?? []);
      setCustomers(customersData ?? []);

      if (preselectedJobId) {
        const j = (jobsData ?? []).find((x) => x.id === preselectedJobId);
        if (j?.customer_id) setCustomerId(j.customer_id);
      }
    })();
  }, [preselectedJobId, router]);

  // When job changes, default the customer from that job
  function onJobChange(newJobId: string) {
    setJobId(newJobId);
    const j = jobs.find((x) => x.id === newJobId);
    if (j?.customer_id) setCustomerId(j.customer_id);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validItems = items.filter((i) => i.description.trim());
    if (!jobId) {
      toast.warning("Pick a job");
      return;
    }
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
      return;
    }
    setLoading(true);

    const supabase = createClient();

    const { data: invoice, error: invError } = await supabase
      .from("invoices")
      .insert({
        estimate_id: null,
        job_id: jobId,
        customer_id: customerId || null,
        status: "sent",
        due_date: dueDate || null,
      })
      .select("id")
      .single();

    if (invError || !invoice) {
      toast.error(`Failed: ${invError?.message ?? "no invoice returned"}`);
      setLoading(false);
      return;
    }

    const lineInserts = validItems.map((item, idx) => ({
      invoice_id: invoice.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      position: idx,
    }));

    const { error: linesError } = await supabase
      .from("invoice_line_items")
      .insert(lineInserts);

    if (linesError) {
      toast.error(`Lines failed: ${linesError.message}`);
      setLoading(false);
      return;
    }

    toast.success("Invoice created");
    // Carry ?job= forward so the new invoice's back button returns to the job
    // we created from (matches the back-to-job behavior on the other new pages).
    const invoiceHref = preselectedJobId
      ? `/invoices/${invoice.id}?job=${preselectedJobId}`
      : `/invoices/${invoice.id}`;
    setTimeout(() => router.push(invoiceHref), 600);
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
            router.push(preselectedJobId ? `/jobs/${preselectedJobId}` : "/invoices")
          }
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">
            {preselectedJobId ? "Back to job" : "Invoices"}
          </span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          New Invoice
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Job *</span>
            <select
              value={jobId}
              onChange={(e) => onJobChange(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white"
            >
              <option value="">Select a job...</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Customer</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base bg-white"
            >
              <option value="">— No customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-gray-500 mt-1 block">
              Auto-filled from the job, change if needed.
            </span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Due date (optional)
            </span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
            <span className="text-xs text-gray-500 mt-1 block">
              Shows on the invoice and in the office calendar feed.
            </span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Notes (optional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <div>
            <span className="text-sm font-medium text-gray-700">
              Line items *
            </span>
            <div className="mt-2">
              <LineItemEditor items={items} onChange={setItems} />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}
            {loading ? "Creating..." : "Create Invoice"}
          </button>
        </form>
      </main>

    </div>
  );
}
