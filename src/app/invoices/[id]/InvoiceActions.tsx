"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  RefreshCw,
  Loader2,
  Trash2,
  Send,
  Mail,
  MessageSquare,
  DollarSign,
} from "lucide-react";
import { SMS_ENABLED } from "@/lib/smsFeature";
import { formatMoney } from "@/lib/money";
import { validTransitions, type InvoiceStatus } from "@/lib/lifecycles/invoice";

type Channel = "email" | "sms" | "both";

// Office actions for an invoice. The Send-to-customer block (Email / Text /
// Both) mirrors the estimate send control: it hits /api/invoices/[id]/send,
// which delivers via deliverInvoice (mints/keeps the share_token, sends email +
// SMS, stamps sent_at iff delivered) and returns a delivered flag + warnings.
// Text won't deliver until TWILIO_* env vars are set; email until the Resend
// domain is verified — both surface as non-fatal warnings. There is no
// separate "Mark Paid" button: recording a payment for the full balance due
// (Record payment, below — defaults to the full balance) is what marks an
// invoice paid, via /api/invoices/[id]/payments, which accumulates
// amount_paid and flips status server-side. That keeps amount_paid, status,
// and the payments ledger always in sync — a direct status-only write can't
// desync them. Void/Unpaid/Restore + Delete remain direct client writes
// (office RLS) since they don't touch amount_paid.

export default function InvoiceActions({
  invoiceId,
  status,
  balanceDue,
  customerEmail,
  customerPhone,
  connectedProviders,
  accountingExternalId,
}: {
  invoiceId: string;
  status: InvoiceStatus;
  balanceDue: number;
  customerEmail?: string | null;
  customerPhone?: string | null;
  connectedProviders: { id: string; label: string }[];
  accountingExternalId?: string | null;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingReceipt, setSendingReceipt] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  // Record offline (cash/check/other) payment form. amount defaults to the
  // remaining balance so a single tap records full payment; editable for
  // partials / overpayments.
  const [showRec, setShowRec] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recAmount, setRecAmount] = useState<string>(
    balanceDue > 0 ? balanceDue.toFixed(2) : ""
  );
  const [recMethod, setRecMethod] = useState<"cash" | "check" | "other">("cash");
  const [recReference, setRecReference] = useState("");
  const [recDate, setRecDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );

  // Push this invoice to the org's connected bookkeeping provider (one-way:
  // app authors → provider receives + processes payment; paid status flows
  // back). The /api/accounting/sync route is office-gated server-side too.
  async function syncToProvider(providerId: string, label: string) {
    setSyncing(providerId);
    try {
      const res = await fetch(`/api/accounting/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, entity: "invoice", id: invoiceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.externalId) {
        toast.error(data?.error ?? `Sync failed (${res.status})`);
      } else {
        toast.success(`Synced to ${label}`);
        router.refresh();
      }
    } catch {
      toast.error("Sync failed — please try again.");
    } finally {
      setSyncing(null);
    }
  }

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

  // Email a payment receipt to the customer (manual path for offline payments
  // — cash/check — the office recorded by marking the invoice paid). Online
  // (Stripe) payments get Stripe's own receipt, so this is office-triggered.
  // The route recomputes totals server-side and only sends for paid invoices.
  async function sendReceipt() {
    setSendingReceipt(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/receipt`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? `Send failed (${res.status})`);
      } else if (data.ok) {
        toast.success(`Receipt sent to ${data.sentTo?.email ?? "customer"}`);
      } else {
        // Non-fatal provider error (e.g. "email not configured" while Resend
        // is pending) — surface as a warning, not a hard failure.
        toast.warning(data?.error ?? "Receipt not sent");
      }
    } catch {
      toast.error("Send failed — please try again.");
    } finally {
      setSendingReceipt(false);
    }
  }

  // Record an offline payment (cash/check/other). The API accumulates into
  // invoices.amount_paid (preserving the seeded deposit) and flips status to
  // 'paid' once the balance is covered; partials keep it 'sent'.
  async function recordPayment(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number(recAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an amount greater than 0");
      return;
    }
    setRecording(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          method: recMethod,
          reference: recReference.trim() || null,
          paid_at: recDate ? new Date(`${recDate}T00:00:00.000Z`).toISOString() : null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to record payment");
        return;
      }
      toast.success(`Recorded ${formatMoney(amount)} ${recMethod} payment`);
      setShowRec(false);
      setRecReference("");
      setRecAmount(balanceDue > 0 ? balanceDue.toFixed(2) : "");
      router.refresh();
    } catch {
      toast.error("Network error");
    } finally {
      setRecording(false);
    }
  }

  async function updateStatus(newStatus: InvoiceStatus, paidAt: string | null) {
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
  // Status-only gate from the lifecycle module; intersected with the role
  // permission the page already applied by mounting this component at all.
  const nextStatuses = validTransitions(status);
  const canVoid = nextStatuses.includes("void");
  const canMarkUnpaid = status === "paid" && nextStatuses.includes("sent");
  const canRestore = status === "void" && nextStatuses.includes("sent");
  const sendLabel = (() => {
    if (via === "sms") return "Send via Text";
    if (via === "both") return "Send via Email & Text";
    return "Send via Email";
  })();

  return (
    <div className="space-y-2">
      {/* Sync to bookkeeping — one button per connected provider. */}
      {connectedProviders.length > 0 ? (
        <div className="space-y-1">
          <span className="text-sm font-medium text-gray-700">
            Sync to bookkeeping
          </span>
          {connectedProviders.map((p) => {
            const synced = !!accountingExternalId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => syncToProvider(p.id, p.label)}
                disabled={syncing !== null || busy}
                className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {syncing === p.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : synced ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {synced ? `Re-sync to ${p.label}` : `Sync to ${p.label}`}
              </button>
            );
          })}
          {accountingExternalId && (
            <p className="text-[11px] text-green-600">
              Synced ✓ — the invoice is in your bookkeeping. Re-sync to push updates.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-400">
          Connect a bookkeeping provider in Settings to sync this invoice.
        </p>
      )}

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

      {/* Record an offline (cash/check/other) payment. Adds to amount_paid and
          flips status to paid once the balance is covered; partials keep the
          invoice 'sent' and shrink the balance. The Payments section on the
          invoice page lists what's recorded. */}
      {status !== "void" && (
        <div className="space-y-2">
          {!showRec ? (
            <button
              onClick={() => setShowRec(true)}
              disabled={busy}
              className="w-full bg-white border border-gray-300 text-gray-700 py-3 rounded-lg font-semibold text-sm active:bg-gray-50 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <DollarSign className="w-4 h-4" />
              Record payment
            </button>
          ) : (
            <form
              onSubmit={recordPayment}
              className="space-y-2 bg-gray-50 border border-gray-200 rounded-lg p-3"
            >
              <span className="text-sm font-medium text-gray-700">
                Record offline payment
              </span>
              <label className="block">
                <span className="block mb-1 text-xs font-medium text-gray-600">
                  Amount
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={recAmount}
                  onChange={(e) => setRecAmount(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  placeholder={balanceDue > 0 ? formatMoney(balanceDue) : "0.00"}
                />
                {balanceDue > 0 && (
                  <span className="block mt-1 text-xs text-gray-400">
                    Balance due {formatMoney(balanceDue)}
                  </span>
                )}
              </label>
              <label className="block">
                <span className="block mb-1 text-xs font-medium text-gray-600">
                  Method
                </span>
                <select
                  value={recMethod}
                  onChange={(e) =>
                    setRecMethod(e.target.value as "cash" | "check" | "other")
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="cash">Cash</option>
                  <option value="check">Check</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="block">
                <span className="block mb-1 text-xs font-medium text-gray-600">
                  Reference (optional)
                </span>
                <input
                  type="text"
                  value={recReference}
                  onChange={(e) => setRecReference(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  placeholder="Check #, etc."
                />
              </label>
              <label className="block">
                <span className="block mb-1 text-xs font-medium text-gray-600">
                  Date paid
                </span>
                <input
                  type="date"
                  value={recDate}
                  onChange={(e) => setRecDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={recording}
                  className="flex-1 bg-green-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {recording ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <DollarSign className="w-4 h-4" />
                  )}
                  Save payment
                </button>
                <button
                  type="button"
                  onClick={() => setShowRec(false)}
                  disabled={recording}
                  className="px-3 py-2 rounded-lg font-semibold text-sm text-gray-600 bg-white border border-gray-300 active:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {canVoid && (
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
      )}

      {canMarkUnpaid && (
        <>
          {hasEmail && (
            <button
              onClick={sendReceipt}
              disabled={sendingReceipt || busy}
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {sendingReceipt ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
              Send receipt
            </button>
          )}
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
        </>
      )}

      {canRestore && (
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