"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { Loader2, Copy, RefreshCw, Trash2, Check } from "lucide-react";

// What each role's feed includes — shown so the user knows what to expect
// before subscribing. Mirrors the feed route's role scoping.
function feedDescription(role: string): string {
  switch (role) {
    case "office":
    case "admin":
    case "superintendent":
    case "project_manager":
      return "Includes job start/end dates, schedule events, subcontractor on-site dates, invoice due dates, and quote expiry dates for your organization.";
    case "crew":
      return "Includes start/end dates and schedule events for the jobs you're assigned to.";
    case "customer":
      return "Includes start/end dates and schedule events for your jobs, plus your own invoice due dates and quote expiry dates.";
    default:
      return "Includes the calendar events you have access to.";
  }
}

export default function CalendarFeedCard({
  initialUrl,
  role,
  lastFetchedAt,
}: {
  initialUrl: string | null;
  role: string;
  lastFetchedAt: string | null;
}) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [creating, setCreating] = useState(!initialUrl);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-create the feed on first visit if the user has no row yet. No
  // synchronous setCreating(true) here — the initial `creating` state is
  // already `!initialUrl`, so on mount the spinner shows automatically; the
  // button path sets it explicitly (see onClick). First statement is an
  // await, so the mount effect's call triggers no setState in its body.
  async function ensureFeed() {
    const res = await fetch("/api/calendar/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) {
      toast.error(data.error ?? "Could not create feed");
      return;
    }
    setUrl(data.url);
  }

  // Auto-create the feed on first visit if the user has no row yet.
  useEffect(() => {
    (async () => {
      if (!initialUrl) await ensureFeed();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Feed URL copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed — long-press to copy manually");
    }
  }

  async function regenerate() {
    if (!confirm("Regenerate the link? Your existing subscribed calendar will stop updating until you paste the new URL.")) {
      return;
    }
    setBusy(true);
    const res = await fetch("/api/calendar/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotate: true }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      toast.error(data.error ?? "Could not regenerate");
      return;
    }
    setUrl(data.url);
    toast.success("New link generated — old URL no longer works");
  }

  async function revoke() {
    if (!confirm("Revoke the feed? Your subscribed calendar will stop updating.")) {
      return;
    }
    setBusy(true);
    const res = await fetch("/api/calendar/token", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(data.error ?? "Could not revoke");
      return;
    }
    setUrl(null);
    toast.success("Feed revoked");
  }

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
      <h2 className="text-sm font-semibold text-gray-500 uppercase">
        Subscribe URL
      </h2>
      <p className="text-xs text-gray-600">{feedDescription(role)}</p>

      {creating ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Preparing your feed…
        </div>
      ) : url ? (
        <>
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-xs text-gray-700 bg-gray-50 font-mono"
            />
            <button
              onClick={copy}
              className="px-3 bg-blue-600 text-white rounded-lg font-semibold text-sm active:bg-blue-700 flex items-center justify-center"
              title="Copy"
            >
              {copied ? (
                <Check className="w-4 h-4" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={regenerate}
              disabled={busy}
              className="flex-1 bg-white border border-gray-300 text-gray-900 py-2 rounded-lg font-semibold text-xs active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate
            </button>
            <button
              onClick={revoke}
              disabled={busy}
              className="flex-1 bg-white border border-red-200 text-red-700 py-2 rounded-lg font-semibold text-xs active:bg-red-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Revoke
            </button>
          </div>
          {lastFetchedAt && (
            <p className="text-[11px] text-gray-400">
              Last polled by a calendar provider:{" "}
              {new Date(lastFetchedAt).toLocaleString()}
            </p>
          )}
        </>
      ) : (
        <button
          onClick={() => {
            setCreating(true);
            void ensureFeed();
          }}
          className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700"
        >
          Create feed link
        </button>
      )}
    </section>
  );
}