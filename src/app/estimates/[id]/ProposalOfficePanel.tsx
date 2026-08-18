// ProposalOfficePanel.tsx
// Office authoring panel for the construction estimate detail page. Toggles the
// estimate to be sent as a proposal that requires e-signature via the Client
// Portal, collects a cover-letter intro + accent banner color, and exposes a
// "Send as Proposal" button. The parent passes `onSend`, which auto-saves the
// estimate before hitting the send API — so the office never has to remember a
// separate Save step (the send API reads the saved DB row, not local state).

"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Loader2, Send } from "lucide-react";

type Props = {
  customerEmail: string | null;
  requiresSignature: boolean;
  onRequiresSignatureChange: (v: boolean) => void;
  proposalIntro: string;
  onProposalIntroChange: (v: string) => void;
  proposalAccent: string;
  onProposalAccentChange: (v: string) => void;
  editable: boolean;
  // Parent-provided: saves the estimate (silent) then POSTs /send. Owns toasts.
  onSend: () => Promise<void>;
};

export default function ProposalOfficePanel({
  customerEmail,
  requiresSignature,
  onRequiresSignatureChange,
  proposalIntro,
  onProposalIntroChange,
  proposalAccent,
  onProposalAccentChange,
  editable,
  onSend,
}: Props) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const handleSend = async () => {
    setBusy(true);
    try {
      await onSend();
    } catch {
      toast.error("Send failed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
      <h2 className="text-sm font-semibold text-gray-700">Proposal & Signature</h2>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-700">
          Send as a proposal (require e-signature)
        </label>
        <input
          type="checkbox"
          checked={requiresSignature}
          onChange={(e) => onRequiresSignatureChange(e.target.checked)}
          disabled={!editable}
          className="w-5 h-5 disabled:opacity-50"
        />
      </div>
      {requiresSignature && (
        <>
          <label className="text-sm font-medium text-gray-700">
            Cover letter / intro (shown to the customer above the estimate)
          </label>
          <textarea
            rows={4}
            value={proposalIntro}
            onChange={(e) => onProposalIntroChange(e.target.value)}
            disabled={!editable}
            placeholder="Welcome note to your client..."
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base disabled:bg-gray-50"
          />
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              value={proposalAccent || "#1e293b"}
              onChange={(e) => onProposalAccentChange(e.target.value)}
              disabled={!editable}
              className="w-10 h-10 rounded border border-gray-300 p-1 disabled:opacity-50"
            />
            <p className="text-xs text-gray-400">
              Banner color on the customer sign page (defaults to your brand dark).
            </p>
          </div>
          {editable && (
            <button
              onClick={handleSend}
              disabled={busy || !customerEmail}
              className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
              {busy ? "Sending..." : "Send as Proposal"}
            </button>
          )}
          {customerEmail ? (
            <p className="text-xs text-gray-500">
              One click saves + sends. The customer gets a magic-link sign-in to
              review and sign the proposal.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Link a customer with an email before sending.
            </p>
          )}
        </>
      )}
      {!requiresSignature && (
        <p className="text-xs text-gray-400">
          Toggle on to require the customer to sign this proposal in the Client Portal.
        </p>
      )}
    </section>
  );
}