"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  Loader2,
  Trash2,
  Send,
  Mail,
  MessageSquare,
} from "lucide-react";
import { SMS_ENABLED } from "@/lib/smsFeature";

type Channel = "email" | "sms" | "both";

// Office actions for an invoice. The Send-to-customer block (Email / Text /
// Both) mirrors the estimate send control: it hits /api/invoices/[id]/send,
// which delivers via deliverInvoice (mints/keeps the share_token, sends email +
// SMS, stamps sent_at iff delivered) and returns a delivered flag + warnings.
// Text won't deliver until TWILIO_* env vars are set; email until the Resend
// domain is verified — both surface as non-fatal warnings. Status buttons (Mark
// Paid/Void/Unpaid/Restore) + Delete are direct client writes (office RLS).

export default function InvoiceActions({
  invoiceId,
  status,
  customerEmail,
  customerPhone,
}: {
  invoiceId: string;
  status: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const hasEmail = !!customerEmail?.trim();
  const hasPhone = !!customerPhone?.trim();
  // Never default to a channel that requires SMS while SMS is "coming soon".
  const [via, setVia] = useState<Channel>(
    hasEmail ? "email" : SMS_ENABLED && hasPhone ? "sms" : "email"
  );

  async function sendToCustomer() {
    setSending(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ via }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Send failed (${res.status})`);
      } else if (data.delivered) {
        const channels = (data.sentVia as string[] | undefined)?.join(" + ") ?? "customer";
        const dest =
          [data.sentTo?.email, data.sentTo?.phone].filter(Boolean).join(" / ") || "customer";
        toast.success(`Sent via ${channels} to ${dest}`);
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
          for (const w of data.warnings) {
            toast.warning(`${w.channel} failed: ${w.message}`);
          }
        }
        router.refresh();
      } else {
        // Nothing delivered (e.g. Resend/Twilio not configured yet).
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
          for (const w of data.warnings) {
            toast.warning(`${w.channel}: ${w.message}`);
          }
        } else {
          toast.warning("Invoice not sent — no email or phone on file.");
        }
      }
    } catch {
      toast.error("Send failed — please try again.");
    } finally {
      setSending(false);
    }
  }

  async function updateStatus(newStatus: string, paidAt: string | null) {
    setBusy(true);
    const { error } = await supabase
      .from("invoices")
      .update({ status: newStatus, paid_at: paidAt, updated_at: new Date().toISOString() })
      .eq("id", invoiceId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success(`Invoice marked ${newStatus}`);
      router.refresh();
    }
    setBusy(false);
  }

  async function deleteInvoice() {
    if (!confirm("Delete this invoice? This can't be undone.")) return;
    setBusy(true);
    const { error } = await supabase.from("invoices").delete().eq("id", invoiceId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Invoice deleted");
      router.push("/invoices");
    }
    setBusy(false);
  }

  // When SMS is "coming soon", only email can deliver — a phone-only customer
  // can't be sent to until SMS is enabled.
  const canSend = status !== "void" && (hasEmail || (SMS_ENABLED && hasPhone));
  const sendLabel = (() => {
    if (via === "sms") return "Send via Text";
    if (via === "both") return "Send via Email & Text";
    return "Send via Email";
  })();

  return (
    <div className="space-y-2">
      {/* Send to customer — gated on what's on file (mirror estimate send). */}
      {canSend && (
        <>
          <div>
            <span className="text-sm font-medium text-gray-700">Send to customer</span>
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

          <button
            onClick={sendToCustomer}
            disabled={sending || busy}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {sending ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
            {sendLabel}
          </button>
        </>
      )}

      {status === "sent" && (
        <>
          <button
            onClick={() => updateStatus("paid", new Date().toISOString())}
            disabled={busy}
            className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-base active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-5 h-5" />
            )}
            Mark Paid
          </button>
          <button
            onClick={() => updateStatus("void", null)}
            disabled={busy}
            className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            Mark Void
          </button>
        </>
      )}

      {status === "paid" && (
        <button
          onClick={() => updateStatus("sent", null)}
          disabled={busy}
          className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4" />
          )}
          Mark Unpaid
        </button>
      )}

      {status === "void" && (
        <button
          onClick={() => updateStatus("sent", null)}
          disabled={busy}
          className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4" />
          )}
          Restore as Unpaid
        </button>
      )}

      <div className="pt-2 mt-2 border-t border-gray-200">
        <button
          onClick={deleteInvoice}
          disabled={busy}
          className="w-full bg-red-50 border border-red-200 text-red-700 py-3 rounded-lg font-semibold text-sm active:bg-red-100 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          Delete Invoice
        </button>
      </div>
    </div>
  );
}