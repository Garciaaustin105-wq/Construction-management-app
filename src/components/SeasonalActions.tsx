"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Loader2, Snowflake, PlayCircle } from "lucide-react";

interface SeasonalActionsProps {
  customerId: string;
  customerName: string;
  activeCount: number;
  pausedCount: number;
  pausedUntil?: string | null;
  today: string;
}

export default function SeasonalActions({
  customerId,
  customerName,
  activeCount,
  pausedCount,
  pausedUntil,
  today,
}: SeasonalActionsProps) {
  const router = useRouter();
  const toast = useToast();
  const [pauseFrom, setPauseFrom] = useState(today);
  const [pauseTo, setPauseTo] = useState("");
  const [pauseBusy, setPauseBusy] = useState(false);
  // Pre-fill the reopen date with the stored auto-resume date when there is
  // one — so "Reopen for spring" opens on the day the pause was set to end.
  const [resumeFrom, setResumeFrom] = useState(pausedUntil ?? today);
  const [reopenBusy, setReopenBusy] = useState(false);

  const handlePause = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pauseFrom || !pauseTo) {
      toast.error("Pick a pause-from and pause-to date");
      return;
    }
    if (pauseFrom > pauseTo) {
      toast.error("Pause-from must be before pause-to");
      return;
    }
    setPauseBusy(true);
    try {
      const res = await fetch("/api/lawn/schedules/bulk-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, pause_from: pauseFrom, pause_to: pauseTo }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to pause");
        return;
      }
      toast.success(`Paused ${customerName}: ${data.paused_schedules} schedule(s) and ${data.paused_visits} visit(s) for winter`);
      router.refresh();
    } catch {
      toast.error("Network error");
    } finally {
      setPauseBusy(false);
    }
  };

  const handleReopen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resumeFrom) {
      toast.error("Pick a reopen date");
      return;
    }
    setReopenBusy(true);
    try {
      const res = await fetch("/api/lawn/schedules/bulk-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, resume_from: resumeFrom }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to reopen");
        return;
      }
      toast.success(`Reopened ${customerName}: ${data.reopened_schedules} schedule(s), resumed ${data.resumed_visits ?? 0} paused visit(s), generated ${data.generated_visits} visit(s)`);
      router.refresh();
    } catch {
      toast.error("Network error");
    } finally {
      setReopenBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {activeCount > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Pause off-season</p>
          <form onSubmit={handlePause} className="space-y-2">
            <label className="block">
              <span className="block mb-1 text-xs font-medium text-gray-600">
                Pause from
              </span>
              <input
                type="date"
                value={pauseFrom}
                onChange={(e) => setPauseFrom(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
            <label className="block">
              <span className="block mb-1 text-xs font-medium text-gray-600">
                Pause to
              </span>
              <input
                type="date"
                value={pauseTo}
                onChange={(e) => setPauseTo(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={pauseBusy}
              className="w-full bg-blue-600 text-white text-sm py-2 rounded-lg font-semibold flex items-center justify-center gap-2 active:bg-blue-700 disabled:opacity-50"
            >
              {pauseBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Snowflake className="w-4 h-4" />
              )}
              Pause for winter
            </button>
          </form>
        </div>
      )}
      {pausedCount > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Reopen for spring</p>
          {pausedUntil && (
            <p className="text-xs text-blue-600 font-medium">
              Auto-resumes {pausedUntil} — reopen now to override
            </p>
          )}
          <form onSubmit={handleReopen} className="space-y-2">
            <label className="block">
              <span className="block mb-1 text-xs font-medium text-gray-600">
                Reopen from
              </span>
              <input
                type="date"
                value={resumeFrom}
                onChange={(e) => setResumeFrom(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={reopenBusy}
              className="w-full bg-green-600 text-white text-sm py-2 rounded-lg font-semibold flex items-center justify-center gap-2 active:bg-green-700 disabled:opacity-50"
            >
              {reopenBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PlayCircle className="w-4 h-4" />
              )}
              Reopen for spring
            </button>
          </form>
        </div>
      )}
    </div>
  );
}