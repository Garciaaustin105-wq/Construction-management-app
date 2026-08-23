"use client";

import { useState } from "react";
import {
  isHappyRating,
  REVIEW_STATUS_LABELS,
  type ReviewRequest,
  type ReviewStatus,
} from "@/lib/reviews";

// Office review-request inbox (lawn). Read-only display + client-side filtering
// of the rating-gate rows the visit status route mints for paid lawn orgs. No
// CRUD, no fetches — the server page seeds the org's rows (RLS-scoped), and
// filtering is purely local state. Offices act on unhappy feedback by following
// up directly, not by editing rows here.

export default function ReviewsInbox({ initial }: { initial: ReviewRequest[] }) {
  const [filter, setFilter] = useState<"all" | "happy" | "unhappy" | "none">(
    "all"
  );

  const filtered = initial.filter((r) => {
    switch (filter) {
      case "happy":
        return isHappyRating(r.rating);
      case "unhappy":
        return r.rating != null && !isHappyRating(r.rating);
      case "none":
        return r.rating == null;
      default:
        return true;
    }
  });

  const total = initial.length;
  const happyCount = initial.filter((r) => isHappyRating(r.rating)).length;
  const unhappyCount = initial.filter(
    (r) => r.rating != null && !isHappyRating(r.rating)
  ).length;
  const noResponseCount = initial.filter((r) => r.rating == null).length;
  const rated = initial.filter((r) => r.rating != null);
  const avg =
    rated.length > 0
      ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
      : null;

  const chipCls =
    "px-3 py-1.5 rounded-full text-sm font-medium transition-colors";
  const tabs: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "happy", label: "Happy" },
    { key: "unhappy", label: "Unhappy" },
    { key: "none", label: "No response" },
  ];

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex flex-wrap gap-2">
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-gray-500">Total</span>{" "}
          <span className="font-semibold text-gray-900">{total}</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-green-600">Happy</span>{" "}
          <span className="font-semibold text-gray-900">{happyCount}</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-red-600">Unhappy</span>{" "}
          <span className="font-semibold text-gray-900">{unhappyCount}</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-gray-500">No response</span>{" "}
          <span className="font-semibold text-gray-900">{noResponseCount}</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm">
          <span className="text-gray-500">Avg</span>{" "}
          <span className="font-semibold text-gray-900">
            {avg != null ? `★ ${avg.toFixed(1)}` : "—"}
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`${chipCls} ${
              filter === t.key
                ? "bg-green-700 text-white"
                : "bg-white text-gray-600 border border-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      {filtered.length > 0 ? (
        <div className="space-y-3">
          {filtered.map((r) => (
            <div
              key={r.id}
              className="bg-white rounded-xl border border-gray-200 p-4 space-y-2"
            >
              <div className="flex justify-between items-center gap-2">
                <div className="text-sm font-semibold text-gray-900 truncate">
                  {r.customers?.name || "Unknown customer"}
                </div>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${
                    r.status === "happy"
                      ? "bg-green-100 text-green-700"
                      : r.status === "unhappy"
                      ? "bg-red-100 text-red-700"
                      : r.status === "opened"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {REVIEW_STATUS_LABELS[r.status as ReviewStatus]}
                </span>
              </div>

              {r.rating != null ? (
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: 5 }, (_, i) => (
                    <span
                      key={i}
                      className={`text-xl leading-none ${
                        i < r.rating! ? "text-amber-400" : "text-gray-300"
                      }`}
                    >
                      ★
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">No rating yet</p>
              )}

              {r.feedback && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 text-sm text-gray-700">
                  {r.feedback}
                </div>
              )}

              <div className="text-xs text-gray-400">
                via {r.channel} · Requested{" "}
                {new Date(r.created_at).toLocaleDateString()}
                {r.completed_at && (
                  <> · Answered {new Date(r.completed_at).toLocaleDateString()}</>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center text-gray-500 py-10">
          {filter === "all"
            ? "No review requests yet. They appear here when you mark a visit done (paid plans)."
            : "No requests in this filter."}
        </div>
      )}
    </div>
  );
}