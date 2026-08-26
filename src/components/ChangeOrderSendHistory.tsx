"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

// Office send-history panel for a change order (Issue 3). Lists every archived
// `change_order_sends` row — each is an immutable snapshot of exactly what the
// customer received at send time, linked from the "View" action. The read is
// RLS-scoped to the caller's org (no manual org filter). `sent_by` is resolved
// to a display name via a separate batched `profiles` read (no PostgREST embed
// — the codebase avoids embeds on profiles).
type SendRow = {
  id: string;
  sent_at: string | null;
  sent_by: string | null;
  sent_via: string | null;
  recipient: string | null;
};

type ResolvedSend = {
  row: SendRow;
  senderName: string | null;
};

export default function ChangeOrderSendHistory({
  changeOrderId,
}: {
  changeOrderId: string;
}) {
  const [sends, setSends] = useState<ResolvedSend[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabaseMod = await import("@/lib/supabase/client");
      const supabase = supabaseMod.createClient();
      const { data } = await supabase
        .from("change_order_sends")
        .select("id, sent_at, sent_by, sent_via, recipient")
        .eq("change_order_id", changeOrderId)
        .order("sent_at", { ascending: false });
      if (cancelled) return;
      const sendRows = (data ?? []) as unknown as SendRow[];

      // Resolve sender display names in one batched read (only non-null ids).
      const senderIds = Array.from(
        new Set(sendRows.map((r) => r.sent_by).filter(Boolean))
      ) as string[];
      const nameById = new Map<string, string | null>();
      if (senderIds.length > 0) {
        const { data: senders } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", senderIds);
        for (const p of (senders ?? []) as {
          id: string;
          full_name: string | null;
        }[]) {
          nameById.set(p.id, p.full_name ?? null);
        }
      }
      if (cancelled) return;
      setSends(
        sendRows.map((row) => ({
          row,
          senderName: row.sent_by ? (nameById.get(row.sent_by) ?? null) : null,
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [changeOrderId]);

  if (sends === null) {
    return (
      <div className="bg-white rounded-lg shadow-sm p-4 flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-4 space-y-2">
      <h2 className="text-sm font-semibold text-gray-500 uppercase">
        Send history
      </h2>
      {sends.length === 0 ? (
        <p className="text-xs text-gray-400">Not sent yet.</p>
      ) : (
        sends.map(({ row, senderName }) => (
          <div
            key={row.id}
            className="flex items-center justify-between border-t border-gray-100 py-2 first:border-t-0"
          >
            <div className="min-w-0">
              <p className="text-sm text-gray-800 truncate">
                {row.sent_at
                  ? new Date(row.sent_at).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "—"}
              </p>
              <p className="text-xs text-gray-500 truncate">
                {row.sent_by ? `by ${senderName ?? "office"}` : null}
                {row.recipient ? ` · to ${row.recipient}` : ""}
                {row.sent_via ? ` · via ${row.sent_via}` : ""}
              </p>
            </div>
            <Link
              href={`/change-orders/${changeOrderId}/sends/${row.id}`}
              className="text-sm text-blue-600 flex-shrink-0 ml-2"
            >
              View
            </Link>
          </div>
        ))
      )}
    </div>
  );
}