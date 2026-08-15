"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { CloudRain, Loader2 } from "lucide-react";

// Per-day "Move all" action under a rain-risk day on the Weather board. POSTs
// the bulk-move, toasts the outcome, then router.refresh() so the server
// component re-renders with fresh visit/forecast data.
export default function LawnWeatherMover({
  fromDate,
  toDate,
}: {
  fromDate: string;
  toDate: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const fmt = new Date(`${toDate}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  async function move() {
    setBusy(true);
    try {
      const res = await fetch("/api/lawn/visits/bulk-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate, toDate }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to move visits");
        return;
      }
      const moved: number = data?.moved ?? 0;
      const conflicts: { jobName: string; dueDate: string }[] =
        data?.conflicts ?? [];
      if (moved > 0 && conflicts.length === 0) {
        toast.success(`Moved ${moved} visit${moved > 1 ? "s" : ""} to ${fmt}`);
      } else if (moved > 0 && conflicts.length > 0) {
        toast.warning(
          `Moved ${moved}, ${conflicts.length} already scheduled on ${fmt}`
        );
      } else if (moved === 0 && conflicts.length > 0) {
        toast.warning(`All ${conflicts.length} already scheduled on ${fmt}`);
      } else {
        toast.info("Nothing to move");
      }
      router.refresh();
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={move}
      disabled={busy}
      className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg font-semibold flex items-center justify-center gap-2 active:bg-blue-700 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <CloudRain className="w-4 h-4" />
      )}
      Move all to {fmt}
    </button>
  );
}