"use client";

import { Mail, Phone } from "lucide-react";
import { LEAD_SOURCES, type Lead } from "@/lib/leads";

// One lead, as it appears on the pipeline board.
//
// PURELY PRESENTATIONAL — no dnd-kit, no Supabase, no state. The board wraps
// this in a sortable and owns the drag wiring, which keeps the drag mechanics
// in one place and lets this component be rendered anywhere (including inside
// dnd-kit's DragOverlay, where attaching sortable listeners a second time would
// misbehave).

const SOURCE_CHIP: Record<string, string> = {
  website: "bg-blue-50 text-blue-700",
  referral: "bg-purple-50 text-purple-700",
  google: "bg-amber-50 text-amber-700",
  manual: "bg-gray-100 text-gray-600",
  other: "bg-gray-100 text-gray-600",
};

const SOURCE_LABEL = new Map(LEAD_SOURCES.map((s) => [s.value, s.label]));

/**
 * Compact relative age ("3d", "2h", "now").
 *
 * Deliberately coarse and non-reactive: it renders once per board paint and
 * never ticks. A live-updating timestamp on every card would re-render the
 * whole board once a minute for no real benefit — the office cares that a lead
 * is "from Tuesday", not that it is 4 minutes old.
 */
function shortAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export default function LeadCard({
  lead,
  onClick,
}: {
  lead: Lead;
  onClick: () => void;
}) {
  // Prefer email, fall back to phone — a card has room for one contact line and
  // showing both crowds out the name at mobile widths.
  const contact = lead.email ?? lead.phone ?? null;
  const ContactIcon = lead.email ? Mail : Phone;

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-md border border-gray-200 p-2.5 shadow-sm cursor-pointer active:bg-gray-50 hover:border-gray-300"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900 truncate flex-1 min-w-0">
          {lead.name}
        </p>
        <span className="text-[10px] text-gray-400 shrink-0 tabular-nums">
          {shortAge(lead.created_at)}
        </span>
      </div>

      {lead.contact_name && (
        <p className="text-xs text-gray-500 truncate">{lead.contact_name}</p>
      )}

      {contact && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-gray-400 truncate">
          <ContactIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{contact}</span>
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
            SOURCE_CHIP[lead.source] ?? SOURCE_CHIP.other
          }`}
        >
          {SOURCE_LABEL.get(lead.source) ?? lead.source}
        </span>
        {lead.service_interest && (
          <span className="text-[10px] text-gray-400 truncate">
            {lead.service_interest}
          </span>
        )}
      </div>
    </div>
  );
}
