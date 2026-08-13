"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import LineItemEditor, { LineItem } from "@/components/LineItemEditor";

export default function EditQuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [quoteId, setQuoteId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [items, setItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    (async () => {
      const { id } = await params;
      setQuoteId(id);
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

      const { data: quote } = await supabase
        .from("quotes")
        .select("notes, status, valid_until")
        .eq("id", id)
        .single();

      if (!quote || quote.status !== "draft") {
        toast.error("Only draft quotes can be edited");
        router.push(`/quotes/${id}`);
        return;
      }

      setNotes(quote.notes ?? "");
      setValidUntil(quote.valid_until ?? "");
      setAuthorized(true);

      const { data: lines } = await supabase
        .from("quote_line_items")
        .select("description, quantity, unit_price, position")
        .eq("quote_id", id)
        .order("position");

      setItems(
        (lines ?? []).map((l) => ({
          description: l.description,
          quantity: Number(l.quantity),
          unit_price: Number(l.unit_price),
        }))
      );
      // If no lines, start with one empty row
      if ((lines ?? []).length === 0) {
        setItems([{ description: "", quantity: 1, unit_price: 0 }]);
      }
    })();
  }, [params, router, toast]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validItems = items.filter((i) => i.description.trim());
    if (validItems.length === 0) {
      toast.warning("Add at least one line item");
      return;
    }
    setLoading(true);

    const supabaseMod = await import("@/lib/supabase/client");
    const supabase = supabaseMod.createClient();

    const { error: updateError } = await supabase
      .from("quotes")
      .update({
        notes: notes || null,
        valid_until: validUntil || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", quoteId);

    if (updateError) {
      toast.error(`Failed: ${updateError.message}`);
      setLoading(false);
      return;
    }

    // Replace line items wholesale (simpler than diffing)
    await supabase.from("quote_line_items").delete().eq("quote_id", quoteId);

    const lineInserts = validItems.map((item, idx) => ({
      quote_id: quoteId,
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

    toast.success("Quote updated");
    setTimeout(() => router.push(`/quotes/${quoteId}`), 600);
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
          onClick={() => router.push(`/quotes/${quoteId}`)}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Quote
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          Edit Quote
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
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
          </label>

          <div>
            <span className="text-sm font-medium text-gray-700">Line items</span>
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
            {loading ? "Saving..." : "Save Changes"}
          </button>
        </form>
      </main>

    </div>
  );
}