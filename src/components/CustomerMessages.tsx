"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { Loader2, Send } from "lucide-react";

// Bidirectional message thread for the authed customer portal. Fetches the
// thread on mount + after each send; the office replies appear on the next
// refresh (ClientPullToRefresh on the parent, or a manual pull). Posts via
// /api/portal-messages (sender='client' is inferred + RLS-pinned server-side).
// A short polling fallback keeps the thread fresh while the portal is open so
// the customer sees office replies without a manual refresh (v1; real-time is a
// later stretch).
type Msg = {
  id: string;
  sender: "client" | "office";
  body: string;
  created_at: string;
  read_at: string | null;
};

export default function CustomerMessages({ customerId }: { customerId: string }) {
  const toast = useToast();
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/portal-messages?customerId=${customerId}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.messages)) {
        setMessages(data.messages as Msg[]);
      }
    } catch {
      // Silent: a transient fetch failure keeps the last-known thread visible.
    }
  }

  useEffect(() => {
    // Initial thread load. Calling load() (which setState's after an await) in
    // the effect body trips react-hooks/set-state-in-effect, but this is the
    // standard "fetch on mount + poll" subscription pattern (same disable used
    // by AccountingConnectButton). The setState happens
    // asynchronously after the fetch resolves, not synchronously during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // Light polling (every 20s) so office replies surface while the customer
    // has the portal open. Stops on unmount.
    pollRef.current = setInterval(load, 20_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const res = await fetch("/api/portal-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error ?? "Could not send message");
        setSending(false);
        return;
      }
      setDraft("");
      await load();
    } catch {
      toast.error("Network error — try again.");
    }
    setSending(false);
  }

  if (messages === null) {
    return (
      <div className="bg-white rounded-lg p-4 flex items-center justify-center text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden flex flex-col">
      <div className="flex-1 space-y-2 p-3 max-h-80 overflow-y-auto">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-6">
            No messages yet. Send a question or update to your project team below.
          </p>
        )}
        {messages.map((m) => {
          const mine = m.sender === "client";
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
        })}
      </div>
      <form onSubmit={send} className="border-t border-gray-100 p-2 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message your project team…"
          maxLength={4000}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-base min-w-0"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="bg-brand text-white px-3 rounded-lg font-semibold active:bg-brand-dark disabled:opacity-50 flex items-center justify-center"
          aria-label="Send message"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </form>
    </div>
  );
}