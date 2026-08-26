import Link from "next/link";
import { CheckCircle2, XCircle, DollarSign, Bell, ClipboardList, FileCheck, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NotificationItem = {
  id: string;
  type: string; // estimate_approved | estimate_rejected | invoice_paid | daily_log_submitted | punch_item_completed | change_order_approved | change_order_rejected | submittal_returned
  title: string;
  body: string | null;
  href: string | null;
  read_at: string | null; // null = unread
  created_at: string; // ISO timestamp
};

// Relative time, computed at render (server-side). No Date.now() at module scope.
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function iconFor(type: string): { Icon: LucideIcon; color: string } {
  switch (type) {
    case "estimate_approved":
      return { Icon: CheckCircle2, color: "text-green-600" };
    case "estimate_rejected":
      return { Icon: XCircle, color: "text-red-600" };
    case "invoice_paid":
      return { Icon: DollarSign, color: "text-green-600" };
    // Needs a human decision (refund or credit), so it reads as a warning
    // rather than another green "money arrived" row.
    case "invoice_overpaid":
      return { Icon: AlertTriangle, color: "text-amber-600" };
    case "daily_log_submitted":
      return { Icon: ClipboardList, color: "text-blue-600" };
    case "punch_item_completed":
      return { Icon: CheckCircle2, color: "text-green-600" };
    case "change_order_approved":
      return { Icon: CheckCircle2, color: "text-green-600" };
    case "change_order_rejected":
      return { Icon: XCircle, color: "text-red-600" };
    case "submittal_returned":
      return { Icon: FileCheck, color: "text-indigo-600" };
    default:
      return { Icon: Bell, color: "text-gray-400" };
  }
}

// Pure presentational office feed. Unread rows are bold with a blue dot; the
// whole row is a link when href is present. No client hooks, no Supabase.
export default function NotificationsFeed({
  notifications,
}: {
  notifications: NotificationItem[];
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2">
        Notifications
      </h2>
      <div className="bg-white rounded-lg shadow-sm divide-y">
        {notifications.length === 0 ? (
          <div className="p-3 text-sm text-gray-500">No notifications yet</div>
        ) : (
          notifications.map((n) => {
            const { Icon, color } = iconFor(n.type);
            const unread = n.read_at === null;
            const titleClass = unread
              ? "font-bold text-gray-900"
              : "font-medium text-gray-700";

            // Row = a Link when href present, else a plain div. The divided
            // child is this element (not a wrapper) so hover fills the row.
            const inner = (
              <>
                <Icon className={`w-4 h-4 ${color} flex-shrink-0 mt-0.5`} />
                <div className="min-w-0 flex-1 ml-3">
                  <h3 className={`truncate ${titleClass}`}>{n.title}</h3>
                  {n.body && (
                    <p className="text-xs text-gray-500 truncate">{n.body}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">
                    {timeAgo(n.created_at)}
                  </p>
                </div>
                {unread && (
                  <span className="inline-block w-2 h-2 rounded-full bg-blue-600 flex-shrink-0 mt-1.5" />
                )}
              </>
            );

            const className = "block p-3 flex active:bg-gray-50";

            return n.href ? (
              <Link key={n.id} href={n.href} className={className}>
                {inner}
              </Link>
            ) : (
              <div key={n.id} className={className}>
                {inner}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}