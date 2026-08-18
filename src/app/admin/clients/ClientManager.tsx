"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import {
  ArrowLeft,
  Mail,
  MailCheck,
  Send,
  Loader2,
  MessageSquare,
  CircleDot,
} from "lucide-react";

export type ClientRow = {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  phone: string | null;
  invited: boolean;
};

type Msg = {
  id: string;
  sender: "client" | "office";
  body: string;
  created_at: string;
  read_at: string | null;
};

// Office Client Portal manager. Two surfaces in one component:
//   1. The client list — every customer with a portal-status chip (Invited /
//      Not invited / No email) and an Invite/Resend button (→ /api/clients/
//      invite, which mints a magic link + emails it).
//   2. The message inbox — select a customer to open their thread; reply as the
//      office (sender='office', RLS-pinned); opening the thread marks the
//      customer's unread client messages read (→ /api/portal-messages/read).
// Desktop renders list + thread side-by-side; mobile renders the list, then the
// thread with a Back button when a customer is selected.
export default function ClientManager({
  initial,
  canEdit = true,
}: {
  initial: ClientRow[];
  canEdit?: boolean;
}) {
  const toast = useToast();
  const [clients, setClients] = useState<ClientRow[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyInvite, setBusyInvite] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const selected = clients.find((c) => c.id === selectedId) ?? null;

  async function invite(c: ClientRow) {
    if (!c.contact_email) {
      toast.warning("Add a contact email to this customer first.");
      return;
    }
    setBusyInvite(c.id);
    try {
      const res = await fetch("/api/clients/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: c.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? "Invite failed");
        setBusyInvite(null);
        return;
      }
      setClients((prev) =>
        prev.map((p) => (p.id === c.id ? { ...p, invited: true } : p))
      );
      toast.success(
        data.sentVia === "none"
          ? "Invited, but the email failed to send — ask the client to request a sign-in link from /login."
          : `Sign-in link sent (${data.sentVia}).`
      );
    } catch {
      toast.error("Network error — try again.");
    }
    setBusyInvite(null);
  }

  async function openThread(c: ClientRow) {
    setSelectedId(c.id);
    setMessages(null);
    setDraft("");
    try {
      const res = await fetch(`/api/portal-messages?customerId=${c.id}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.messages)) {
        setMessages(data.messages as Msg[]);
      } else {
        setMessages([]);
      }
      // Mark the customer's unread client messages read (best-effort).
      fetch("/api/portal-messages/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: c.id }),
      }).catch(() => {});
    } catch {
      setMessages([]);
    }
  }

  async function reply(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const res = await fetch("/api/portal-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: selectedId, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? "Could not send");
        setSending(false);
        return;
      }
      setDraft("");
      // Reload the thread to show the new office message.
      const r = await fetch(`/api/portal-messages?customerId=${selectedId}`, {
        cache: "no-store",
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(d.messages)) setMessages(d.messages as Msg[]);
    } catch {
      toast.error("Network error — try again.");
    }
    setSending(false);
  }

  // ── Thread pane (shared by desktop + mobile) ───────────────────────────
  const threadPane = selected ? (
    <div className="flex flex-col h-[70vh] lg:h-[calc(100vh-9rem)] bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 p-3 border-b border-gray-100">
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className="lg:hidden text-gray-500 active:text-gray-700"
          aria-label="Back to clients"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{selected.name}</p>
          <p className="text-xs text-gray-500 truncate">
            {selected.contact_email ?? "No contact email"}
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages === null ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">
            No messages yet. Start the conversation below.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.sender === "office";
            return (
              <div
                key={m.id}
                className={`flex ${mine ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                    mine
                      ? "bg-brand text-white rounded-br-sm"
                      : "bg-gray-100 text-gray-800 rounded-bl-sm"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p
                    className={`mt-1 text-[10px] ${mine ? "text-brand/70" : "text-gray-400"}`}
                  >
                    {new Date(m.created_at).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
      <form onSubmit={reply} className="border-t border-gray-100 p-2 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Reply to client…"
          maxLength={4000}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-base min-w-0"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="bg-brand text-white px-3 rounded-lg font-semibold active:bg-brand-dark disabled:opacity-50 flex items-center justify-center"
          aria-label="Send reply"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  ) : (
    <div className="hidden lg:flex flex-col items-center justify-center h-[calc(100vh-9rem)] text-gray-400">
      <MessageSquare className="w-8 h-8 mb-2" />
      <p className="text-sm">Select a client to view their message thread.</p>
    </div>
  );

  return (
    <div className="lg:grid lg:grid-cols-2 lg:gap-4">
      {/* Client list */}
      <div className={selected ? "hidden lg:block" : ""}>
        <div className="space-y-2">
          {clients.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">
              No customers yet. Add them from the Customers tab first.
            </p>
          )}
          {clients.map((c) => (
            <div
              key={c.id}
              className="bg-white rounded-lg shadow-sm p-3 flex items-start gap-3"
            >
              <button
                type="button"
                onClick={() => openThread(c)}
                className="flex-1 min-w-0 text-left"
              >
                <p className="font-semibold text-gray-900 truncate">{c.name}</p>
                <p className="text-xs text-gray-500 truncate">
                  {c.contact_email ?? c.phone ?? "No contact info"}
                </p>
                <p className="mt-1 text-[11px] flex items-center gap-1">
                  {c.invited ? (
                    <span className="text-green-600 inline-flex items-center gap-1">
                      <MailCheck className="w-3 h-3" /> Invited
                    </span>
                  ) : c.contact_email ? (
                    <span className="text-amber-600 inline-flex items-center gap-1">
                      <CircleDot className="w-3 h-3" /> Not invited
                    </span>
                  ) : (
                    <span className="text-gray-400 inline-flex items-center gap-1">
                      <CircleDot className="w-3 h-3" /> No email
                    </span>
                  )}
                </p>
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => invite(c)}
                  disabled={!c.contact_email || busyInvite === c.id}
                  className="shrink-0 text-xs font-semibold px-3 py-2 rounded-lg bg-brand text-white active:bg-brand-dark disabled:opacity-50 flex items-center gap-1"
                >
                  {busyInvite === c.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : c.invited ? (
                    <Mail className="w-3 h-3" />
                  ) : (
                    <Mail className="w-3 h-3" />
                  )}
                  {c.invited ? "Resend" : "Invite"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Thread pane */}
      <div>{threadPane}</div>
    </div>
  );
}