"use client";

import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Loader2, Save } from "lucide-react";
import { useState, useMemo } from "react";
import LineItemEditor, { type LineItem } from "@/components/LineItemEditor";

type DraftLineItemsProps = {
  invoiceId: string;
  initialItems: {
    id: string;
    description: string;
    quantity: number;
    unit_price: number;
    position: number;
  }[];
};

export default function DraftLineItems({
  invoiceId,
  initialItems,
}: DraftLineItemsProps) {
  const router = useRouter();
  const toast = useToast();

  const mapToLineItem = (item: {
    description: string;
    quantity: number;
    unit_price: number;
  }): LineItem => ({
    description: item.description,
    quantity: item.quantity,
    unit_price: item.unit_price,
  });

  const [items, setItems] = useState<LineItem[]>(
    initialItems.map(mapToLineItem)
  );
  const [lastSaved, setLastSaved] = useState<LineItem[]>(
    initialItems.map(mapToLineItem)
  );
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(items) !== JSON.stringify(lastSaved),
    [items, lastSaved]
  );

  const hasMeaningfulRow = items.some(
    (row) =>
      row.description.trim() !== "" ||
      row.quantity > 0 ||
      row.unit_price > 0
  );

  const buttonDisabled = saving || !dirty || !hasMeaningfulRow;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/line-items`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });

      const data = await res.json();

      if (res.ok) {
        toast.success("Line items saved");
        setLastSaved(items);
        router.refresh();
      } else {
        toast.error(data?.error ?? "Save failed");
        if (res.status === 409) router.refresh();
      }
    } catch {
      toast.error("Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <LineItemEditor items={items} onChange={setItems} disabled={saving} />
      {dirty && !saving && (
        <p className="text-sm text-gray-500">Unsaved changes</p>
      )}
      <button
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        disabled={buttonDisabled}
        onClick={handleSave}
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}