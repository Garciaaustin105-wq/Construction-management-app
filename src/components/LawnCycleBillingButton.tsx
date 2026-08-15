"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Loader2, FileText } from "lucide-react";

// Generates this cycle's lawn invoices (one per customer from done-unbilled
// visits) and refreshes the preview. Server does the work; this just calls it.

export default function LawnCycleBillingButton() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    let res: Response;
    try {
      res = await fetch("/api/lawn/billing/cycle", { method: "POST" });
    } catch {
      setBusy(false);
      toast.error("Failed: network error");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(`Failed: ${data.error ?? res.statusText}`);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      invoicesCreated?: number;
      visitsBilled?: number;
      skippedNoCustomer?: number;
    };
    const inv = data.invoicesCreated ?? 0;
    const vis = data.visitsBilled ?? 0;
    if (inv === 0) {
      toast.info("No new visits to bill this cycle");
    } else {
      toast.success(
        `Created ${inv} invoice${inv === 1 ? "" : "s"} · ${vis} visit${
          vis === 1 ? "" : "s"
        } billed`
      );
    }
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
    >
      {busy ? (
        <Loader2 className="w-5 h-5 animate-spin" />
      ) : (
        <FileText className="w-5 h-5" />
      )}
      Generate cycle invoices
    </button>
  );
}