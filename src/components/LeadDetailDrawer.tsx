"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2, Trash2, UserPlus, X, ArrowRight } from "lucide-react";
import {
  LEAD_SOURCES,
  LEAD_STAGES,
  convertLeadToCustomer,
  type Lead,
  type LeadSource,
  type LeadStatus,
} from "@/lib/leads";
import LinkEstimateToLead from "@/components/LinkEstimateToLead";

// Edit / assign / notes / convert / delete for one lead.
//
// Writes go straight through RLS with the browser client (policy
// `lead_office_all` → tier_office_or_pm), mirroring CustomersManager. There is
// no /api/leads/[id] by design.

export type OrgMember = { id: string; full_name: string | null };

export default function LeadDetailDrawer({
  lead,
  orgId,
  members,
  onClose,
  onSaved,
  onDeleted,
  onConverted,
}: {
  lead: Lead;
  orgId: string;
  members: OrgMember[];
  onClose: () => void;
  onSaved: (patch: Partial<Lead>) => void;
  onDeleted: () => void;
  onConverted: (customerId: string) => void;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [showConvert, setShowConvert] = useState(false);

  // The "Customer limit reached" path. Held in its own state rather than fired
  // as a toast: it needs a persistent panel with a link to billing, and a toast
  // that vanishes in 3 seconds is exactly the wrong treatment for the one
  // message that is supposed to sell an upgrade.
  const [capError, setCapError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: lead.name,
    contact_name: lead.contact_name ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    address: lead.address ?? "",
    service_interest: lead.service_interest ?? "",
    source: lead.source as LeadSource,
    referral_detail: lead.referral_detail ?? "",
    notes: lead.notes ?? "",
    assigned_to: lead.assigned_to ?? "",
    status: lead.status as LeadStatus,
  });

  // Convert form, prefilled from the lead. Kept separate from `form` so editing
  // the customer-to-be never silently rewrites the lead record.
  const [convertForm, setConvertForm] = useState({
    name: lead.name,
    contact_name: lead.contact_name ?? "",
    contact_email: lead.email ?? "",
    phone: lead.phone ?? "",
    address: lead.address ?? "",
    service_plan: lead.service_interest ?? "",
  });

  // Escape closes. Bound to the document because focus may be inside any field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const alreadyConverted = !!lead.converted_customer_id;

  async function save() {
    if (!form.name.trim()) {
      toast.warning("Name is required");
      return;
    }
    setSaving(true);
    // Empty strings become null: the columns are nullable and "" would render
    // as a present-but-blank value everywhere downstream.
    const patch = {
      name: form.name.trim(),
      contact_name: form.contact_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      service_interest: form.service_interest.trim() || null,
      source: form.source,
      referral_detail: form.referral_detail.trim() || null,
      notes: form.notes.trim() || null,
      assigned_to: form.assigned_to || null,
      status: form.status,
    };
    const { error } = await supabase.from("leads").update(patch).eq("id", lead.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    onSaved(patch);
  }

  async function convert() {
    if (!convertForm.name.trim()) {
      toast.warning("Customer name is required");
      return;
    }
    setConverting(true);
    setCapError(null);

    const { customerId, error } = await convertLeadToCustomer(supabase, {
      leadId: lead.id,
      orgId,
      name: convertForm.name.trim(),
      contact_name: convertForm.contact_name.trim() || null,
      contact_email: convertForm.contact_email.trim() || null,
      phone: convertForm.phone.trim() || null,
      address: convertForm.address.trim() || null,
      service_plan: convertForm.service_plan.trim() || null,
      notes: form.notes.trim() || null,
    });
    setConverting(false);

    // A customer id means the customer EXISTS, even when `error` is also set —
    // that combination is the documented partial success (customer created, the
    // lead just wasn't flagged won). Treating it as a failure would push the
    // office to convert again and create a duplicate customer.
    if (customerId) {
      if (error) toast.warning(error);
      else toast.success("Converted to customer");
      onConverted(customerId);
      return;
    }

    // No customer id → real failure. The cap trigger's message is the upgrade
    // nudge; show it verbatim and persistently.
    setCapError(error ?? "Could not convert this lead");
  }

  async function remove() {
    if (!confirm(`Delete "${lead.name}"? This can't be undone.`)) return;
    setDeleting(true);
    const { error } = await supabase.from("leads").delete().eq("id", lead.id);
    setDeleting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Lead deleted");
    onDeleted();
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — click closes. */}
      <div
        className="flex-1 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Lead: ${lead.name}`}
        className="w-full sm:w-[420px] bg-gray-50 h-full overflow-y-auto shadow-xl flex flex-col"
      >
        <header className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 truncate">
            {lead.name}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-gray-400 hover:text-gray-700"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="p-4 space-y-4 flex-1">
          {alreadyConverted && (
            <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              Already converted to a customer.
            </p>
          )}

          {/* ── Details ─────────────────────────────────────────────── */}
          <section className="bg-white rounded-lg p-3 shadow-sm space-y-2">
            <input
              className={field}
              placeholder="Lead name *"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              className={field}
              placeholder="Contact name"
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={field}
                type="email"
                placeholder="Email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
              <input
                className={field}
                type="tel"
                placeholder="Phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <input
              className={field}
              placeholder="Address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
            <input
              className={field}
              placeholder="Service interest (e.g. weekly mowing)"
              value={form.service_interest}
              onChange={(e) =>
                setForm({ ...form, service_interest: e.target.value })
              }
            />
          </section>

          {/* ── Pipeline ────────────────────────────────────────────── */}
          <section className="bg-white rounded-lg p-3 shadow-sm space-y-2">
            <label className="block">
              <span className="text-xs font-medium text-gray-600">Stage</span>
              {/* A select as well as drag-and-drop: keyboard and screen-reader
                  users get a first-class path, and it's how you move a card
                  back OUT of won/lost, which the board intentionally forbids
                  dragging. */}
              <select
                className={`${field} mt-1`}
                value={form.status}
                onChange={(e) =>
                  setForm({ ...form, status: e.target.value as LeadStatus })
                }
              >
                {LEAD_STAGES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600">Source</span>
              <select
                className={`${field} mt-1`}
                value={form.source}
                onChange={(e) =>
                  setForm({ ...form, source: e.target.value as LeadSource })
                }
              >
                {LEAD_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            {form.source === "referral" && (
              <input
                className={field}
                placeholder="Who referred them?"
                value={form.referral_detail}
                onChange={(e) =>
                  setForm({ ...form, referral_detail: e.target.value })
                }
              />
            )}

            <label className="block">
              <span className="text-xs font-medium text-gray-600">
                Assigned to
              </span>
              <select
                className={`${field} mt-1`}
                value={form.assigned_to}
                onChange={(e) =>
                  setForm({ ...form, assigned_to: e.target.value })
                }
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? "Unnamed"}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {/* ── Notes ──────────────────────────────────────────────── */}
          <section className="bg-white rounded-lg p-3 shadow-sm">
            <textarea
              className={field}
              rows={4}
              placeholder="Notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </section>

          <button
            onClick={save}
            disabled={saving}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </button>

          {/* ── Convert ────────────────────────────────────────────── */}
          {!alreadyConverted && (
            <section className="bg-white rounded-lg p-3 shadow-sm space-y-2">
              {!showConvert ? (
                <button
                  onClick={() => setShowConvert(true)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold active:bg-emerald-700"
                >
                  <UserPlus className="h-4 w-4" />
                  Convert to customer
                </button>
              ) : (
                <>
                  <p className="text-xs text-gray-600">
                    Creates a customer from this lead and marks it won.
                  </p>
                  <input
                    className={field}
                    placeholder="Customer name *"
                    value={convertForm.name}
                    onChange={(e) =>
                      setConvertForm({ ...convertForm, name: e.target.value })
                    }
                  />
                  <input
                    className={field}
                    placeholder="Contact name"
                    value={convertForm.contact_name}
                    onChange={(e) =>
                      setConvertForm({
                        ...convertForm,
                        contact_name: e.target.value,
                      })
                    }
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className={field}
                      placeholder="Email"
                      value={convertForm.contact_email}
                      onChange={(e) =>
                        setConvertForm({
                          ...convertForm,
                          contact_email: e.target.value,
                        })
                      }
                    />
                    <input
                      className={field}
                      placeholder="Phone"
                      value={convertForm.phone}
                      onChange={(e) =>
                        setConvertForm({ ...convertForm, phone: e.target.value })
                      }
                    />
                  </div>
                  <input
                    className={field}
                    placeholder="Address"
                    value={convertForm.address}
                    onChange={(e) =>
                      setConvertForm({ ...convertForm, address: e.target.value })
                    }
                  />
                  <input
                    className={field}
                    placeholder="Service plan"
                    value={convertForm.service_plan}
                    onChange={(e) =>
                      setConvertForm({
                        ...convertForm,
                        service_plan: e.target.value,
                      })
                    }
                  />

                  {capError && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      {/* Verbatim, by contract — this is the trigger's own
                          wording and the whole point of the cap. */}
                      <p className="text-sm font-medium text-amber-900">
                        {capError}
                      </p>
                      <Link
                        href="/admin/billing"
                        className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-amber-900 underline"
                      >
                        Upgrade your plan to add more customers
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={convert}
                      disabled={converting}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                    >
                      {converting && <Loader2 className="h-4 w-4 animate-spin" />}
                      Confirm
                    </button>
                    <button
                      onClick={() => {
                        setShowConvert(false);
                        setCapError(null);
                      }}
                      className="px-3 py-2.5 border border-gray-300 rounded-lg text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {/* ── Link estimate (§5.3) ─────────────────────────────────── */}
          <LinkEstimateToLead
            lead={lead}
            onLinked={(estimateId) =>
              onSaved({ estimate_id: estimateId, status: "quoted" })
            }
          />

          <button
            onClick={remove}
            disabled={deleting}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-red-600 disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete lead
          </button>
        </div>
      </aside>
    </div>
  );
}
