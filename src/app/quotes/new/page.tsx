"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import { useToast } from "@/components/Toast";
import LineItemEditor, { LineItem } from "@/components/LineItemEditor";

function NewQuoteForm() {
  const router = useRouter();
  const search = useSearchParams();
  const preselectedJob = search.get("job") ?? "";
  const toast = useToast();

  const [jobs, setJobs] = useState<{ id: string; name: string; customer_id: string | null }[]>([]);
  const [jobId, setJobId] = useState(preselectedJob);
  const [notes, setNotes] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [items, setItems] = useState<LineItem[]>([
    { description: "", quantity: 1, unit_price: 0 },
  ]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  // Which submit button was pressed — null = Save as Draft, true = Save & Send.
  const sendRef = useRef(false);

  useEffect(() => {
    (async () => {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles").select("role").eq("id", user.id).single();
      if (profile?.role !== "office" && profile?.role !== "admin") {
        router.push("/dashboard");
        return;
      }
      setAuthorized(true);
      const { data } = await supabase
        .from("jobs")
        .select("id, name, customer_id")
        .order("created_at", { ascending: false });
      setJobs(data ?? []);
    })();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // sendRef is set by whichever button was clicked (see onClick handlers).
    if (!jobId) {
      toast.warning("Pick a job");
      return;
    }
    const validItems = items.filter((i) => i.description.trim());
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

    const job = jobs.find((j) => j.id === jobId);

    const { data: quote, error } = await supabase
      .from("quotes")
      .insert({
        job_id: jobId,
        customer_id: job?.customer_id ?? null,
        status: "draft",
        notes: notes || null,
        valid_until: validUntil || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (error || !quote) {
      toast.error(`Failed to create quote: ${error?.message ?? "unknown error"}`);
      setLoading(false);
      return;
    }

    const lineInserts = validItems.map((item, idx) => ({
      quote_id: quote.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      position: idx,
    }));

    const { error: linesError } = await supabase
      .from("quote_line_items")
      .insert(lineInserts);

    if (linesError) {
      toast.error(`Lines failed: ${linesError.message}`);
      setLoading(false);
      return;
    }

    // Draft saved. If the office chose "Save & Send", email the customer now.
    // On email failure the draft still exists — toast the error and stay on the
    // form so they can fix the customer email and resend from the detail page.
    // The detail-page href carries ?job= so its back button returns to the job
    // we created from (matches the list-first flow's back-to-job behavior).
    const quoteHref = preselectedJob
      ? `/quotes/${quote.id}?job=${preselectedJob}`
      : `/quotes/${quote.id}`;
    if (sendRef.current) {
      setSending(true);
      try {
        const res = await fetch(`/api/quotes/${quote.id}/send`, {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(
            data?.error ??
              "Saved as draft, but send failed — open the quote to resend."
          );
          router.push(quoteHref);
          return;
        }
        toast.success(`Sent to ${data.sentTo ?? "customer"}`);
      } catch {
        toast.error(
          "Saved as draft, but send failed — open the quote to resend."
        );
      } finally {
        setSending(false);
      }
    } else {
      toast.success("Quote saved as draft");
    }
    setTimeout(() => router.push(quoteHref), 600);
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
            router.push(preselectedJob ? `/jobs/${preselectedJob}` : "/quotes")
          }
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1 max-w-[45%]"
        >
          <ArrowLeft className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">
            {preselectedJob ? "Back to job" : "Quotes"}
          </span>
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          New Quote
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
            <span className="text-sm font-medium text-gray-700">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Visible to the customer with the quote"
              rows={3}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">
              Valid until (optional)
            </span>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            />
            <span className="text-xs text-gray-500 mt-1 block">
              Expiry date shown to the customer + the calendar feed.
            </span>
          </label>

          <div>
            <span className="text-sm font-medium text-gray-700">Line items</span>
            <div className="mt-2">
              <LineItemEditor items={items} onChange={setItems} />
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <button
              type="submit"
              onClick={() => {
                sendRef.current = true;
              }}
              disabled={loading || sending}
              className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {(loading || sending) && <Loader2 className="w-5 h-5 animate-spin" />}
              {sending ? (
                "Sending..."
              ) : loading ? (
                "Creating..."
              ) : (
                <>
                  <Send className="w-5 h-5" />
                  Save &amp; Send to Customer
                </>
              )}
            </button>
            <button
              type="submit"
              onClick={() => {
                sendRef.current = false;
              }}
              disabled={loading || sending}
              className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-base active:bg-gray-50 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Save as Draft"}
            </button>
          </div>
        </form>
      </main>

    </div>
  );
}

export default function NewQuotePage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Loading...</p></div>}>
      <NewQuoteForm />
    </Suspense>
  );
}