"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2 } from "lucide-react";

// Inline due-date control on the invoice detail page. Office/admin/PM may edit
// (RLS "office_or_pm update invoices" allows the browser-client update); other
// roles see the date read-only. Surfaced in the office calendar feed.
export default function InvoiceDueDate({
  invoiceId,
  initial,
  canEdit,
}: {
  invoiceId: string;
  initial: string | null;
  canEdit: boolean;
}) {
  const supabase = createClient();
  const toast = useToast();
  const [value, setValue] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);

  async function commit(v: string) {
    setValue(v);
    setSaving(true);
    const { error } = await supabase
      .from("invoices")
      .update({ due_date: v || null })
      .eq("id", invoiceId);
    setSaving(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    toast.success("Due date saved");
  }

  if (canEdit) {
    return (
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Due date</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="date"
            value={value}
            onChange={(e) => commit(e.target.value)}
            disabled={saving}
            className="px-3 py-2 border border-gray-300 rounded-lg text-base"
          />
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        </div>
      </label>
    );
  }

  if (!initial) return null;
  return (
    <p className="text-sm text-gray-700">
      <span className="text-gray-500">Due:</span>{" "}
      {new Date(initial + "T00:00:00").toLocaleDateString()}
    </p>
  );
}