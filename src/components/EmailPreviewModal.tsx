"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { ModalHeader } from "@/components/ui/Modal";
import { withMobileStyle } from "@/lib/emailPreviewStyle";
import { useToast } from "@/components/Toast";

// In-page "preview before send" popup (Issue 1). Shows the customer-facing email
// EXACTLY as the customer will receive it — the same `renderXEmail` fn the send
// route uses renders this preview (drift-proof, via /api/email-preview), so what
// the office sees is byte-identical to what ships. The only intentional
// difference: the link URL uses "(link generates on send)" instead of the
// minted token (the preview never mints/persists a token).
//
// Same-tab overlay (the shared Modal), no navigation — QuickBooks-style. The
// compose fields (channel / personal note / reviewer email) stay in the page;
// this modal is preview + confirm only. `onConfirm` is the page-level send,
// refactored to return success; the page still owns toasts + router.refresh.

export type EmailPreviewKind =
  | "estimate"
  | "invoice"
  | "change_order"
  | "submittal";

export default function EmailPreviewModal({
  open,
  onClose,
  kind,
  recordId,
  message,
  toLabel,
  channelNote,
  sendLabel,
  onConfirm,
  canSend = true,
}: {
  open: boolean;
  onClose: () => void;
  kind: EmailPreviewKind;
  recordId: string;
  // Live personal note from page state. null = no note line (matches a send with
  // no note); a string = that note. Passed to /api/email-preview so the preview
  // reflects exactly what the office typed.
  message: string | null;
  // Display-only "To: …" (customer email or the typed reviewer email).
  toLabel?: string;
  // Multi-channel hint above the preview (e.g. "Sending via Email + Text").
  channelNote?: string;
  sendLabel: string;
  // The page-level send. Returns true on success (modal closes) / false on
  // failure (modal stays open; the page already toasted the error).
  onConfirm: () => Promise<boolean>;
  canSend?: boolean;
}) {
  const toast = useToast();
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  // Debounce so a rapidly-edited note doesn't fire a fetch per keystroke.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      // Reset on close so a reopen doesn't flash the previous email. Deferred:
      // the modal is already closed at this point, so nothing renders the
      // cleared values this tick and the visible result is unchanged.
      queueMicrotask(() => {
        setSubject("");
        setHtml("");
      });
      return;
    }
    let cancelled = false;
    // Same deferral as the close path above. A microtask is imperceptible to
    // the spinner but keeps this out of the commit phase.
    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/email-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: kind, recordId, message }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          toast.error(data?.error ?? `Preview failed (${res.status})`);
          setSubject("");
          setHtml("");
        } else {
          setSubject(data.subject ?? "");
          setHtml(data.html ?? "");
        }
      } catch {
        if (!cancelled) toast.error("Preview failed — please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, kind, recordId, message, toast]);

  async function handleConfirm() {
    setSending(true);
    try {
      const ok = await onConfirm();
      if (ok) onClose();
      // On failure, stay open — the page-level toast already explained it.
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      // Wider than the default lg:max-w-md (the email body is 560px); fixed
      // height so the iframe scrolls internally, not the panel.
      panelClassName="lg:max-w-2xl h-[90vh] max-h-[90vh] flex flex-col overflow-hidden"
    >
      <ModalHeader title="Preview email" onClose={onClose} />

      <div className="px-4 py-2 border-b border-line space-y-0.5 flex-shrink-0">
        {subject && (
          <p className="text-sm font-medium text-gray-900 truncate">
            {subject}
          </p>
        )}
        {toLabel && (
          <p className="text-xs text-gray-500 truncate">{toLabel}</p>
        )}
        {channelNote && (
          <p className="text-xs text-gray-500 truncate">{channelNote}</p>
        )}
      </div>

      <div className="flex-1 min-h-0 p-3 bg-gray-50">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : html ? (
          <iframe
            title="Email preview"
            srcDoc={withMobileStyle(html)}
            className="w-full h-full bg-white border border-gray-200 rounded-lg"
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            No preview available.
          </div>
        )}
      </div>

      <div className="p-3 border-t border-line flex gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onClose}
          disabled={sending}
          className="flex-1 bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={sending || !canSend || loading}
          className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          {sendLabel}
        </button>
      </div>
    </Modal>
  );
}