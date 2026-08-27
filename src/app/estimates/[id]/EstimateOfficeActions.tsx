"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import EmailPreviewModal from "@/components/EmailPreviewModal";
import { Send, Trash2, Loader2, Receipt, X, Mail, MessageSquare } from "lucide-react";
import { SMS_ENABLED } from "@/lib/smsFeature";

type Channel = "email" | "sms" | "both";

// Office actions for an estimate on the Preview & Send tab. Owns the send
// channel (Email / Text / Both) + the optional personal note shown at the top
// of the send email. Send hits the service-role /api/estimates/[id]/send route
// (delivers, then marks sent); Mark Rejected and Delete are direct client
// writes (office RLS allows both). Resend rotates the share_token (old links
// stop working) and re-delivers. Text (SMS) goes via Twilio and won't deliver
// until TWILIO_* env vars are set — the route returns a clear "not configured"
// error in that case; email is unaffected.
export default function EstimateOfficeActions({
  estimateId,
  status,
  invoiceId,
  jobId,
  customerEmail,
  customerPhone,
}: {
  estimateId: string;
  status: string;
  invoiceId: string | null;
  jobId?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const jobQuery = jobId ? `?job=${jobId}` : "";

  const hasEmail = !!customerEmail?.trim();
  const hasPhone = !!customerPhone?.trim();
  // Default to email when available, else text, else email (so the empty case
  // still shows the email hint rather than a dead text control). Never default
  // to a channel that requires SMS while SMS is "coming soon".
  const [via, setVia] = useState<Channel>(
    hasEmail ? "email" : SMS_ENABLED && hasPhone ? "sms" : "email"
  );

  // Returns true on success (the EmailPreviewModal closes on true), false on
  // failure (the modal stays open; the toast below already explained it).
  async function sendToCustomer(): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ via, message: message.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Send failed (${res.status})`);
        return false;
      }
      const channels = (data.sentVia as string[] | undefined)?.join(" + ") ?? "customer";
      const dest = [data.sentTo?.email, data.sentTo?.phone].filter(Boolean).join(" / ") || "customer";
      toast.success(`Sent via ${channels} to ${dest}`);
      // Surface partial failures (e.g. email failed because Resend isn't
      // verified yet, while the text went out) without erasing the success.
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        for (const w of data.warnings) {
          toast.warning(`${w.channel} failed: ${w.message}`);
        }
      }
      router.refresh();
      return true;
    } catch {
      toast.error("Send failed — please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    const { error } = await supabase
      .from("estimates")
      .update({ status: "rejected", rejected_at: new Date().toISOString() })
      .eq("id", estimateId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Estimate marked as rejected");
      router.refresh();
    }
    setBusy(false);
  }

  async function deleteEstimate() {
    if (!confirm("Delete this draft estimate? This can't be undone.")) return;
    setBusy(true);
    const { error } = await supabase
      .from("estimates")
      .delete()
      .eq("id", estimateId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Estimate deleted");
      router.push(jobId ? `/jobs/${jobId}` : "/estimates");
    }
    setBusy(false);
  }

  const canSend = status === "draft" || status === "sent";
  // When SMS is "coming soon", only email can actually deliver — so a phone-only
  // customer can't be sent to until SMS is enabled.
  const canSendAny = canSend && (hasEmail || (SMS_ENABLED && hasPhone));

  // Send button label reflects the chosen channel (and Resend vs Send).
  const sendLabel = (() => {
    const prefix = status === "sent" ? "Resend" : "Send";
    if (via === "sms") return `${prefix} via Text`;
    if (via === "both") return `${prefix} via Email & Text`;
    return `${prefix} via Email`;
  })();

  const toLabel = hasEmail && hasPhone
    ? `To ${customerEmail} and ${customerPhone}`
    : hasEmail
    ? `To ${customerEmail}`
    : hasPhone
    ? `To ${customerPhone}`
    : "No email or phone on file";
  const channelNote =
    via === "sms"
      ? "Sending via Text"
      : via === "both"
      ? "Sending via Email + Text"
      : "Sending via Email";

  return (
    <div className="space-y-3">
      {canSend && (
        <>
          {/* Channel selector — gated on what's on file. Text/Both need a
              phone; Email/Both need an email. Disabling the option (rather
              than hiding it) keeps the layout stable and tells the office
              exactly which contact field is missing. */}
          <div>
            <span className="text-sm font-medium text-gray-700">Send via</span>
            <div className="mt-1 grid grid-cols-3 gap-1 bg-gray-100 rounded-lg p-1">
              <button
                type="button"
                onClick={() => setVia("email")}
                disabled={!hasEmail}
                className={`py-2 rounded-md text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${
                  via === "email" ? "bg-white text-blue-700 shadow-sm" : "text-gray-600"
                }`}
              >
                <Mail className="w-3.5 h-3.5" /> Email
              </button>
              <button
                type="button"
                onClick={() => setVia("sms")}
                disabled={!hasPhone || !SMS_ENABLED}
                className={`py-2 rounded-md text-xs font-semibold flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed ${
                  via === "sms" ? "bg-white text-blue-700 shadow-sm" : "text-gray-600"
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" /> Text
              </button>
              <button
                type="button"
                onClick={() => setVia("both")}
                disabled={!hasEmail || !hasPhone || !SMS_ENABLED}
                className={`py-2 rounded-md text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed ${
                  via === "both" ? "bg-white text-blue-700 shadow-sm" : "text-gray-600"
                }`}
              >
                Both
              </button>
            </div>
            {!SMS_ENABLED && (
              <p className="text-[11px] text-amber-600 mt-1">
                Text (SMS) is coming soon — only Email is available right now.
              </p>
            )}
            <p className="text-xs text-gray-500 mt-1">
              {hasEmail && hasPhone
                ? `To ${customerEmail} and ${customerPhone}`
                : hasEmail
                ? `To ${customerEmail}`
                : hasPhone
                ? `To ${customerPhone}`
                : "No email or phone on file — add one in Customers first."}
            </p>
          </div>

          {/* Personal note is email-only (an SMS is too short to carry it). */}
          {via !== "sms" && (
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Personal note (added to the email)
              </span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                placeholder="Added to the top of the email, e.g. &ldquo;Hi Jane, here&rsquo;s the estimate we discussed&hellip;&rdquo;"
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
            </label>
          )}
        </>
      )}

      {canSend && (
        <button
          onClick={() => setPreviewOpen(true)}
          disabled={busy || !canSendAny}
          className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
          {sendLabel}
        </button>
      )}

      {status === "sent" && (
        <button
          onClick={reject}
          disabled={busy}
          className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <X className="w-4 h-4" />
          )}
          Mark Rejected
        </button>
      )}

      {status === "draft" && (
        <button
          onClick={deleteEstimate}
          disabled={busy}
          className="w-full bg-red-50 border border-red-200 text-red-700 py-3 rounded-lg font-semibold text-sm active:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Delete draft
        </button>
      )}

      {status === "approved" && invoiceId && (
        <button
          onClick={() => router.push(`/invoices/${invoiceId}${jobQuery}`)}
          className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-base active:bg-green-700 flex items-center justify-center gap-2"
        >
          <Receipt className="w-5 h-5" />
          View Invoice
        </button>
      )}

      {canSend && (
        <EmailPreviewModal
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          kind="estimate"
          recordId={estimateId}
          message={message.trim() || null}
          toLabel={toLabel}
          channelNote={channelNote}
          sendLabel={sendLabel}
          onConfirm={sendToCustomer}
        />
      )}
    </div>
  );
}