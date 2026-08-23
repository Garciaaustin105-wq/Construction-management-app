"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Link2, Loader2, Plus, X } from "lucide-react";
import { LEAD_STAGES, leadFormUrl, type Lead, type LeadStatus } from "@/lib/leads";
import LeadCard from "@/components/LeadCard";
import LeadDetailDrawer, { type OrgMember } from "@/components/LeadDetailDrawer";

// The office lead pipeline: a 5-column drag-drop Kanban over LEAD_STAGES.
//
// CRUD is client-side through RLS (`lead_office_all` → tier_office_or_pm),
// mirroring CustomersManager — there is no /api/leads/[id] by design.
//
// TERMINAL STAGES: won/lost cards are non-draggable. A lead that has been won
// silently sliding back to "new" because someone brushed a touchscreen is a
// data-integrity problem, not a UX nicety — especially once `won` carries a
// converted_customer_id. Moving one back out is still possible, deliberately
// through the drawer's Stage select, where it's an explicit choice.

const STAGE_VALUES = new Set<string>(LEAD_STAGES.map((s) => s.value));
const TERMINAL = new Set<string>(
  LEAD_STAGES.filter((s) => s.terminal).map((s) => s.value)
);

const COLUMN_ACCENT: Record<string, string> = {
  new: "text-blue-700",
  contacted: "text-amber-700",
  quoted: "text-purple-700",
  won: "text-emerald-700",
  lost: "text-gray-500",
};

// ---------------------------------------------------------------------------
// Sortable wrapper
// ---------------------------------------------------------------------------
// Kept separate from LeadCard so LeadCard stays free of dnd-kit: the same
// component is rendered inside DragOverlay, where a second set of sortable
// listeners would fight the one being dragged.

function SortableLead({
  lead,
  disabled,
  onOpen,
}: {
  lead: Lead;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: lead.id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-40" : undefined}
      {...attributes}
      {...listeners}
    >
      <LeadCard lead={lead} onClick={onOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

function Column({
  stage,
  label,
  leads,
  onOpen,
}: {
  stage: LeadStatus;
  label: string;
  leads: Lead[];
  onOpen: (lead: Lead) => void;
}) {
  // The column itself is a drop target, which is what makes dropping into an
  // EMPTY column work — with only card-level targets there would be nothing to
  // land on and the drag would snap back.
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const terminal = TERMINAL.has(stage);

  return (
    <div
      ref={setNodeRef}
      className={`shrink-0 w-[260px] lg:w-auto rounded-lg p-2 transition-colors ${
        isOver ? "bg-gray-200" : "bg-gray-100"
      }`}
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <span
          className={`text-xs font-semibold uppercase tracking-wide ${
            COLUMN_ACCENT[stage] ?? "text-gray-700"
          }`}
        >
          {label}
        </span>
        <span className="text-xs text-gray-400 tabular-nums">{leads.length}</span>
      </div>

      <SortableContext
        items={leads.map((l) => l.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-2 min-h-[80px]">
          {leads.map((lead) => (
            <SortableLead
              key={lead.id}
              lead={lead}
              disabled={terminal}
              onOpen={() => onOpen(lead)}
            />
          ))}
          {leads.length === 0 && (
            <p className="text-[11px] text-gray-400 text-center py-6 border border-dashed border-gray-300 rounded-md">
              Drop here
            </p>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export default function LeadsBoard({
  initial,
  orgId,
  leadFormToken,
}: {
  initial: Lead[];
  orgId: string;
  leadFormToken: string | null;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [leads, setLeads] = useState<Lead[]>(initial);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [copied, setCopied] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLead, setNewLead] = useState({ name: "", phone: "", email: "" });

  const sensors = useSensors(
    // A small activation distance so a tap that opens the drawer isn't
    // swallowed as a micro-drag — without it, every click starts a drag on
    // touch devices and the card never opens.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Org members for the drawer's "Assigned to" select. Fetched once here rather
  // than per-drawer-open so opening ten leads is one query, not ten.
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("organization_id", orgId);
      setMembers((data as OrgMember[]) ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const byStage = useMemo(() => {
    const map = new Map<LeadStatus, Lead[]>();
    for (const stage of LEAD_STAGES) map.set(stage.value, []);
    for (const lead of leads) map.get(lead.status)?.push(lead);
    // Newest first within a column.
    for (const list of map.values()) {
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return map;
  }, [leads]);

  const activeLead = activeId ? leads.find((l) => l.id === activeId) ?? null : null;
  const openLead = openLeadId ? leads.find((l) => l.id === openLeadId) ?? null : null;

  const patchLead = useCallback((id: string, patch: Partial<Lead>) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const leadId = String(active.id);
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return;

    // `over` is either a column (droppable id = stage) or another card
    // (sortable id = lead id). Resolve both to a destination stage.
    const overId = String(over.id);
    const destination = STAGE_VALUES.has(overId)
      ? (overId as LeadStatus)
      : leads.find((l) => l.id === overId)?.status;

    if (!destination || destination === lead.status) return;

    // Optimistic: move it now, roll back if the write fails. The board is
    // effectively single-user per org, so a conflicting concurrent edit isn't
    // worth a refetch round trip on every drop.
    const previous = lead.status;
    patchLead(leadId, { status: destination });

    const { error } = await supabase
      .from("leads")
      .update({ status: destination })
      .eq("id", leadId);

    if (error) {
      patchLead(leadId, { status: previous });
      toast.error(error.message);
    }
  }

  async function addLead(e: React.FormEvent) {
    e.preventDefault();
    const name = newLead.name.trim();
    if (!name) {
      toast.warning("Lead name is required");
      return;
    }
    setAdding(true);
    const { data, error } = await supabase
      .from("leads")
      .insert({
        organization_id: orgId,
        name,
        phone: newLead.phone.trim() || null,
        email: newLead.email.trim() || null,
        status: "new",
        source: "manual",
      })
      .select("*")
      .single();
    setAdding(false);

    if (error || !data) {
      toast.error(error?.message ?? "Could not add lead");
      return;
    }
    setLeads((prev) => [data as Lead, ...prev]);
    setNewLead({ name: "", phone: "", email: "" });
    setShowAdd(false);
    toast.success("Lead added");
  }

  async function copyLink() {
    if (!leadFormToken) return;
    try {
      await navigator.clipboard.writeText(leadFormUrl(leadFormToken));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions). Fall back to
      // telling them the URL rather than failing silently.
      toast.info(leadFormUrl(leadFormToken));
    }
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <p className="text-sm text-gray-600 flex-1">
          {leads.length} lead{leads.length === 1 ? "" : "s"}
        </p>

        {leadFormToken && (
          <button
            onClick={copyLink}
            className="flex items-center gap-1.5 text-xs font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5 active:bg-green-100"
          >
            <Link2 className="h-3.5 w-3.5" />
            {copied ? "Copied!" : "Copy lead form link"}
          </button>
        )}

        <button
          onClick={() => setShowAdd((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {showAdd ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showAdd ? "Cancel" : "Add lead"}
        </button>
      </div>

      {/* Manual entry */}
      {showAdd && (
        <form
          onSubmit={addLead}
          className="bg-white rounded-lg p-3 shadow-sm space-y-2"
        >
          <input
            autoFocus
            placeholder="Lead name *"
            value={newLead.name}
            onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="Phone"
              value={newLead.phone}
              onChange={(e) => setNewLead({ ...newLead, phone: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              placeholder="Email"
              value={newLead.email}
              onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={adding}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {adding && <Loader2 className="h-4 w-4 animate-spin" />}
            Add lead
          </button>
        </form>
      )}

      {/* Board — horizontal scroll on mobile, 5 columns from lg up. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2 lg:grid lg:grid-cols-5 lg:overflow-visible">
          {LEAD_STAGES.map((stage) => (
            <Column
              key={stage.value}
              stage={stage.value}
              label={stage.label}
              leads={byStage.get(stage.value) ?? []}
              onOpen={(lead) => setOpenLeadId(lead.id)}
            />
          ))}
        </div>

        {/* Follows the cursor while dragging. Rendered from the plain card so
            it carries no sortable listeners of its own. */}
        <DragOverlay>
          {activeLead ? (
            <div className="rotate-2 opacity-90">
              <LeadCard lead={activeLead} onClick={() => {}} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {openLead && (
        <LeadDetailDrawer
          lead={openLead}
          orgId={orgId}
          members={members}
          onClose={() => setOpenLeadId(null)}
          onSaved={(patch) => patchLead(openLead.id, patch)}
          onDeleted={() => {
            setLeads((prev) => prev.filter((l) => l.id !== openLead.id));
            setOpenLeadId(null);
          }}
          onConverted={(customerId) => {
            // convertLeadToCustomer already marked it won server-side; mirror
            // that locally so the card moves without a refetch.
            patchLead(openLead.id, {
              status: "won",
              converted_customer_id: customerId,
              converted_at: new Date().toISOString(),
            });
            setOpenLeadId(null);
          }}
        />
      )}
    </div>
  );
}
