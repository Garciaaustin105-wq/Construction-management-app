"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Check, RotateCcw } from "lucide-react";

// Office-side resolve / reopen for a reported install problem.
//
// A plain RLS UPDATE, not an RPC: `office_manage_install_issues`
// (tier_office_or_pm) already gives the office the whole row, so there's
// nothing to narrow. Crew are the ones who needed RPCs, because they must be
// allowed to WRITE without being allowed to write everything.
//
// `installs.has_open_problem` is NOT touched here — the
// trg_sync_install_open_problem trigger recomputes it from the issue rows on
// every insert/update/delete. Setting it by hand from the client would be the
// bug that eventually drifts.
export default function InstallIssueActions({
  issueId,
  status,
  userId,
}: {
  issueId: string;
  status: string;
  userId: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const isOpen = status === "open";

  async function apply(next: "open" | "resolved") {
    setBusy(true);
    const { error } = await supabase
      .from("install_issues")
      .update(
        next === "resolved"
          ? { status: "resolved", resolved_at: new Date().toISOString(), resolved_by: userId }
          : { status: "open", resolved_at: null, resolved_by: null }
      )
      .eq("id", issueId);

    if (error) {
      toast.error(error.message);
    } else {
      toast.success(next === "resolved" ? "Problem resolved" : "Problem reopened");
      router.refresh();
    }
    setBusy(false);
  }

  return isOpen ? (
    <button
      disabled={busy}
      onClick={() => apply("resolved")}
      className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-green-700 border border-green-300 rounded-lg px-2.5 py-1.5 active:bg-green-50 disabled:opacity-50"
    >
      <Check className="w-3.5 h-3.5" /> Mark resolved
    </button>
  ) : (
    <button
      disabled={busy}
      onClick={() => apply("open")}
      className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1.5 active:bg-gray-50 disabled:opacity-50"
    >
      <RotateCcw className="w-3.5 h-3.5" /> Reopen
    </button>
  );
}
