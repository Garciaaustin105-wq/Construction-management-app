"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileCheck, RefreshCw, XCircle, Loader2 } from "lucide-react";

// Frictionless disposition return for the public submittal review view. The
// share token in the URL is the only credential (validated server-side). The
// reviewer picks one of four dispositions; on success the page is refreshed so
// the server-rendered confirmation state shows.
type Disposition = "approved" | "approved_as_noted" | "revise_resubmit" | "rejected";

const OPTIONS: { value: Disposition; label: string; Icon: typeof CheckCircle2; cls: string }[] = [
  { value: "approved", label: "Approved", Icon: CheckCircle2, cls: "bg-green-600 text-white active:bg-green-700" },
  { value: "approved_as_noted", label: "Approved as Noted", Icon: FileCheck, cls: "bg-blue-600 text-white active:bg-blue-700" },
  { value: "revise_resubmit", label: "Revise & Resubmit", Icon: RefreshCw, cls: "bg-amber-500 text-white active:bg-amber-600" },
  { value: "rejected", label: "Rejected", Icon: XCircle, cls: "bg-white border border-gray-300 text-gray-700 active:bg-gray-50" },
];

export default function SubmittalReturnButtons({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Disposition | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(disposition: Disposition) {
    if (!confirm(`Return this submittal as "${OPTIONS.find((o) => o.value === disposition)?.label}"?`))
      return;
    setBusy(disposition);
    setError(null);
    try {
      const res = await fetch(`/api/submittals/by-token/${token}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Return failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Return failed — please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </p>
      )}
      <p className="text-sm font-semibold text-gray-700">Return a disposition</p>
      <div className="grid grid-cols-2 gap-3">
        {OPTIONS.map(({ value, label, Icon, cls }) => (
          <button
            key={value}
            onClick={() => submit(value)}
            disabled={busy !== null}
            className={`flex items-center justify-center gap-2 py-3 px-2 rounded-xl font-semibold text-sm disabled:opacity-50 ${cls}`}
          >
            {busy === value ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Icon className="w-4 h-4" />
            )}
            {label}
          </button>
        ))}
      </div>
      <p className="text-center text-[11px] text-gray-400">
        Your disposition is sent to the office immediately.
      </p>
    </div>
  );
}