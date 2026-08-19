"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Check, X, Loader2 } from "lucide-react";

/**
 * Approve / reject a single time entry. Field-management only at the call site
 * (RLS `Field mgmt review time` admits office/admin/superintendent/PM/
 * super_admin). Writes status + approved_by + approved_at via the client
 * Supabase connection, then refreshes the server-rendered overview.
 */
export default function TimeApproveButton({ entryId }: { entryId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(status: "approved" | "rejected") {
    if (status === "rejected") {
      if (!confirm("Reject this time entry? The crew member will need to correct and resubmit it.")) return;
    }
    setBusy(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("time_entries")
      .update({
        status,
        approved_by: user?.id ?? null,
        approved_at: new Date().toISOString(),
      })
      .eq("id", entryId);
    setBusy(false);
    if (error) {
      alert(`Failed: ${error.message}`);
      return;
    }
    router.refresh();
  }

  if (busy) {
    return <Loader2 className="w-4 h-4 animate-spin text-gray-400 flex-shrink-0" />;
  }

  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      <button
        onClick={() => act("approved")}
        className="text-green-700 p-1.5 rounded hover:bg-green-50"
        title="Approve"
        aria-label="Approve time entry"
      >
        <Check className="w-4 h-4" />
      </button>
      <button
        onClick={() => act("rejected")}
        className="text-red-600 p-1.5 rounded hover:bg-red-50"
        title="Reject"
        aria-label="Reject time entry"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}