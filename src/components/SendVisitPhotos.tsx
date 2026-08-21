"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { Send, Loader2, Mail, MessageSquare } from "lucide-react";
import { SMS_ENABLED } from "@/lib/smsFeature";

type Channel = "email" | "sms" | "both";
type ChannelResult = {
  channel: "email" | "sms";
  status: "sent" | "failed" | "skipped";
  reason?: string;
};

// "Send to customer" for a lawn visit's before/after photos — crew or office,
// from the visit detail page. Mirrors EstimateOfficeActions' channel picker
// (Email / Text / Both, gated on what contact info is on file + SMS_ENABLED)
// and hits the service-role /api/lawn/visits/[id]/send-photos route, which
// delivers a short note + the /v/{token} photo-portal link and logs the
// attempt to notification_log. Text (SMS) is coded but won't deliver until
// Twilio is configured — the route returns a clear "not configured" reason in
// that case; email is unaffected.
//
// Friendly reason strings mirror the visit page's own onMyWay() mapping so a
// skipped/failed channel reads as plain English rather than a raw code.
const REASON_TEXT: Record<string, string> = {
  "opt-out": "customer opted out of this channel",
  "no-contact": "no contact info on file for this channel",
};

function friendlyReason(r: ChannelResult): string {
  return REASON_TEXT[r.reason ?? ""] ?? r.reason ?? "not delivered";
}

export default function SendVisitPhotos({
  visitId,
  customerEmail,
  customerPhone,
}: {
  visitId: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const hasEmail = !!customerEmail?.trim();
  const hasPhone = !!customerPhone?.trim();
  const [via, setVia] = useState<Channel>(
    hasEmail ? "email" : SMS_ENABLED && hasPhone ? "sms" : "email"
  );
  const canSendAny = hasEmail || (SMS_ENABLED && hasPhone);

  async function send() {
    setBusy(true);
    try {
      const res = await fetch(`/api/lawn/visits/${visitId}/send-photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ via, message: message.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Send failed (${res.status})`);
        return;
      }
      const results = (data.results as ChannelResult[] | undefined) ?? [];
      const sentVia = (data.sentVia as string[] | undefined) ?? [];
      if (data.ok) {
        toast.success(`Sent via ${sentVia.join(" + ")}`);
        // Surface a partial miss (e.g. "both" requested but only email
        // delivered) without erasing the success toast above.
        for (const r of results) {
          if (r.status !== "sent") {
            toast.warning(`${r.channel}: ${friendlyReason(r)}`);
          }
        }
        setMessage("");
        setOpen(false);
      } else {
        const first = results[0];
        toast.warning(first ? friendlyReason(first) : "Nothing was delivered");
      }
    } catch {
      toast.error("Send failed — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full bg-white border border-gray-300 text-gray-900 py-2.5 rounded-lg font-semibold text-sm active:bg-gray-50 flex items-center justify-center gap-2"
      >
        <Send className="w-4 h-4" />
        Send to customer
      </button>
    );
  }

  return (
    <div className="space-y-3 border border-gray-200 rounded-lg p-3">
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
        {!canSendAny && (
          <p className="text-[11px] text-red-500 mt-1">
            No email on file for this customer — add one in Customers first.
          </p>
        )}
      </div>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">
          Short note (optional)
        </span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          maxLength={480}
          placeholder="e.g. &ldquo;Finished up today — lawn looks great!&rdquo;"
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setMessage("");
          }}
          disabled={busy}
          className="py-2.5 rounded-lg font-semibold text-sm text-gray-600 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={send}
          disabled={busy || !canSendAny}
          className="bg-blue-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send
        </button>
      </div>
    </div>
  );
}
