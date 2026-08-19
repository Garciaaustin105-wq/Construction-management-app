"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { useRouter } from "next/navigation";
import { Square, Loader2 } from "lucide-react";

// Office/PM action on the /time overview: clock out a crew member who forgot.
// RLS `office time_all` (tier_office_or_pm) permits the update client-side.
export default function ForceClockOutButton({
  entryId,
  workerName,
}: {
  entryId: string;
  workerName?: string | null;
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function forceOut() {
    const who = workerName ? ` ${workerName}` : "";
    if (
      !confirm(
        `Clock out${who} now? This sets their clock-out time to the current time.`
      )
    )
      return;
    setBusy(true);
    const { error } = await supabase
      .from("time_entries")
      .update({ clock_out_at: new Date().toISOString() })
      .eq("id", entryId);
    setBusy(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Clocked out");
      router.refresh();
    }
  }

  return (
    <button
      onClick={forceOut}
      disabled={busy}
      className="text-red-600 p-1.5 rounded hover:bg-red-50 flex-shrink-0 disabled:opacity-50"
      title="Force clock out"
      aria-label="Force clock out"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Square className="w-4 h-4" />
      )}
    </button>
  );
}