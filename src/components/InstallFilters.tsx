"use client";

import { useRouter } from "next/navigation";
import { INSTALL_STATUSES, statusLabel } from "@/lib/installs";

// Status + open-problem filters for the installs list. Mirrors PunchFilters:
// pushes query params and lets the server page re-query, so the filter state
// lives in the URL and survives a refresh / back button / shared link.
export default function InstallFilters({
  currentStatus,
  problemsOnly,
  attentionOnly,
}: {
  currentStatus: string;
  problemsOnly: boolean;
  attentionOnly: boolean;
}) {
  const router = useRouter();

  function apply(nextStatus: string, nextProblems: boolean, nextAttention: boolean) {
    const params = new URLSearchParams();
    if (nextStatus) params.set("status", nextStatus);
    if (nextProblems) params.set("problems", "1");
    if (nextAttention) params.set("attention", "1");
    const qs = params.toString();
    router.push(qs ? `/installs?${qs}` : "/installs");
  }

  return (
    <div className="bg-white rounded-lg p-3 shadow-sm space-y-2">
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Status</span>
        <select
          value={currentStatus}
          onChange={(e) => apply(e.target.value, problemsOnly, attentionOnly)}
          className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">All statuses</option>
          {INSTALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={problemsOnly}
          onChange={(e) => apply(currentStatus, e.target.checked, attentionOnly)}
          className="w-4 h-4"
        />
        <span className="text-sm text-gray-700">Only show open problems</span>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={attentionOnly}
          onChange={(e) => apply(currentStatus, problemsOnly, e.target.checked)}
          className="w-4 h-4"
        />
        <span className="text-sm text-gray-700">
          Only needs attention{" "}
          <span className="text-gray-500">(unfinished or has a problem)</span>
        </span>
      </label>
      {(currentStatus || problemsOnly || attentionOnly) && (
        <button
          onClick={() => apply("", false, false)}
          className="text-xs text-blue-600 font-medium"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
