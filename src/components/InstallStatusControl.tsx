"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Ban, RotateCcw, Check } from "lucide-react";
import {
  INSTALL_STATUSES,
  OUTCOMES,
  statusLabel,
  type CompletionOutcome,
  type InstallStatus,
} from "@/lib/installs";

// Office-side status control for an install, shared by the detail page and the
// edit form so the two surfaces can never drift on the rules.
//
// Invariant (from the original EditInstallForm): an install may never sit in
// `completed` or `needs_followup` without a `completion_outcome` and a
// `completed_at`. The status dropdown enforces that: choosing either finished
// status reveals an outcome <select> that must be set before the change is
// applied. The outcome also decides WHICH finished status applies —
// `completed` → completed, `partial`/`could_not_complete` → needs_followup —
// matching the crew field RPCs.
//
// Writes go through the session client; RLS `office_manage_installs`
// (tier_office_or_pm) authorises them. Crew have no UPDATE policy, so this
// component is only rendered for office/PM.
export default function InstallStatusControl({
  installId,
  status,
  completionOutcome,
  canEdit,
}: {
  installId: string;
  status: string;
  completionOutcome: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // The status the office is moving TO. Defaults to the current status so the
  // dropdown shows where the install actually is.
  const [nextStatus, setNextStatus] = useState<string>(status);
  // The outcome to apply when the target is a finished status.
  const [outcome, setOutcome] = useState<CompletionOutcome>(
    (status === "completed"
      ? "completed"
      : status === "needs_followup"
        ? (completionOutcome as CompletionOutcome) || "partial"
        : "completed")
  );

  const isFinished = (s: string) => s === "completed" || s === "needs_followup";
  const isCancelled = status === "cancelled";
  const alreadyFinished = isFinished(status);

  // A finished status needs an outcome before it can be applied. The dropdown
  // stays enabled but the Apply button is gated.
  const needsOutcome = isFinished(nextStatus);
  const dirty = nextStatus !== status;

  async function apply(next: string, patch: Record<string, unknown>, msg: string) {
    setBusy(true);
    const { error } = await supabase
      .from("installs")
      .update(patch)
      .eq("id", installId);
    setBusy(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success(msg);
      router.refresh();
    }
  }

  // Apply the dropdown selection. Derives the real status from the outcome so
  // the office picks a result, not a raw status string.
  function applyDropdown() {
    if (!dirty) return;
    if (needsOutcome) {
      const realStatus: InstallStatus =
        outcome === "completed" ? "completed" : "needs_followup";
      apply(
        realStatus,
        {
          status: realStatus,
          completion_outcome: outcome,
          completed_at: new Date().toISOString(),
        },
        outcome === "completed" ? "Marked complete" : "Marked needs follow-up"
      );
    } else if (nextStatus === "in_progress") {
      // started_at is only stamped on the first dispatch; a re-dispatch keeps
      // the original start so the tracked-time math stays honest.
      apply(
        "in_progress",
        { status: "in_progress", started_at: new Date().toISOString() },
        "Marked in progress"
      );
    } else if (nextStatus === "scheduled") {
      apply(
        "scheduled",
        { status: "scheduled", completion_outcome: null, completed_at: null },
        "Reopened for another visit"
      );
    } else if (nextStatus === "cancelled") {
      apply("cancelled", { status: "cancelled" }, "Install cancelled");
    }
  }

  // The one-click deliberate transitions (kept alongside the dropdown — they're
  // the safe actions the office uses most, no need to touch the dropdown first).
  function cancel() {
    apply("cancelled", { status: "cancelled" }, "Install cancelled");
  }
  function reopen() {
    apply(
      "scheduled",
      { status: "scheduled", completion_outcome: null, completed_at: null },
      "Reopened for another visit"
    );
  }
  function restore() {
    apply(
      "scheduled",
      { status: "scheduled", completion_outcome: null, completed_at: null },
      "Install restored"
    );
  }

  if (!canEdit) return null;

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">Status</h2>

      {isCancelled ? (
        <>
          <p className="text-xs text-gray-500">
            This install is cancelled. Crew can&apos;t see or act on it.
          </p>
          <button
            disabled={busy}
            onClick={restore}
            className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50 disabled:opacity-50"
          >
            <RotateCcw className="w-4 h-4" /> Restore to scheduled
          </button>
        </>
      ) : (
        <>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Change status</span>
            <select
              value={nextStatus}
              onChange={(e) => {
                setNextStatus(e.target.value);
                if (e.target.value === "completed") setOutcome("completed");
                else if (e.target.value === "needs_followup")
                  setOutcome("partial");
              }}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              {INSTALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>

          {needsOutcome && (
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Outcome</span>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as CompletionOutcome)}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-400">
                {OUTCOMES.find((o) => o.value === outcome)?.hint}
              </span>
            </label>
          )}

          <button
            disabled={busy || !dirty || (needsOutcome && !outcome)}
            onClick={applyDropdown}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white py-3 rounded-lg font-medium active:bg-blue-700 disabled:opacity-50"
          >
            <Check className="w-4 h-4" /> Apply status
          </button>

          {alreadyFinished && (
            <button
              disabled={busy}
              onClick={reopen}
              className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50 disabled:opacity-50"
            >
              <RotateCcw className="w-4 h-4" /> Reopen for another visit
            </button>
          )}

          <p className="text-xs text-gray-500">
            Cancelling keeps the record and its history, but hides it from the
            crew and the calendar.
          </p>
          <button
            disabled={busy}
            onClick={cancel}
            className="w-full flex items-center justify-center gap-2 border border-red-200 text-red-700 py-3 rounded-lg font-medium active:bg-red-50 disabled:opacity-50"
          >
            <Ban className="w-4 h-4" /> Cancel this install
          </button>
        </>
      )}
    </section>
  );
}