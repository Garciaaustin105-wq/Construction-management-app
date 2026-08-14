"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Plus, Trash2, Loader2, Phone, Mail, Briefcase } from "lucide-react";

export type Subcontractor = {
  id: string;
  company: string;
  contact_name: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
};

export default function SubcontractorsManager({
  initial,
  canEdit = true,
  orgId,
}: {
  initial: Subcontractor[];
  canEdit?: boolean;
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();
  const [subs, setSubs] = useState<Subcontractor[]>(initial);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [trade, setTrade] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  async function refresh() {
    const { data } = await supabase
      .from("subcontractors")
      .select("id, company, contact_name, trade, phone, email")
      .order("company");
    setSubs((data as Subcontractor[]) ?? []);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) {
      toast.warning("Company name is required");
      return;
    }
    setAdding(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase.from("subcontractors").insert({
      company: company.trim(),
      contact_name: contactName.trim() || null,
      trade: trade.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      created_by: user?.id ?? null,
      organization_id: orgId,
    });
    setAdding(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    toast.success("Subcontractor added");
    setCompany("");
    setContactName("");
    setTrade("");
    setPhone("");
    setEmail("");
    await refresh();
  }

  async function remove(id: string) {
    if (!customConfirm("Delete this subcontractor? Removes it from all jobs and deletes its files.")) return;
    setBusyId(id);
    // Clean up storage files first (cascade removes the metadata rows).
    const { data: atts } = await supabase
      .from("subcontractor_attachments")
      .select("storage_path")
      .eq("subcontractor_id", id);
    if (atts && atts.length > 0) {
      await supabase.storage
        .from("subcontractor-files")
        .remove(atts.map((a) => a.storage_path));
    }
    const { error } = await supabase.from("subcontractors").delete().eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    toast.success("Deleted");
    await refresh();
  }

  return (
    <div className="space-y-4">
      {/* Add form — office only */}
      {canEdit && (
      <form
        onSubmit={add}
        className="bg-white rounded-lg p-4 shadow-sm space-y-3"
      >
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1">
          <Plus className="w-4 h-4" /> Add Subcontractor
        </h2>
        <input
          type="text"
          placeholder="Company name *"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            placeholder="Contact name"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="text"
            placeholder="Trade (e.g. Electrical)"
            value={trade}
            onChange={(e) => setTrade(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="tel"
            placeholder="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add
        </button>
      </form>
      )}

      {/* List */}
      <div className="space-y-2">
        {subs.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-6">
            No subcontractors yet.
          </p>
        )}
        {subs.map((s) => (
          <div key={s.id} className="bg-white rounded-lg p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/admin/subcontractors/${s.id}`}
                className="min-w-0 flex-1"
              >
                <p className="font-semibold text-gray-900 truncate flex items-center gap-1">
                  <Briefcase className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  {s.company}
                </p>
                {s.trade && (
                  <p className="text-xs text-blue-600 truncate">{s.trade}</p>
                )}
                {s.contact_name && (
                  <p className="text-xs text-gray-500 truncate">{s.contact_name}</p>
                )}
                <div className="flex flex-col gap-0.5 mt-1">
                  {s.phone && (
                    <a
                      href={`tel:${s.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-gray-600 inline-flex items-center gap-1"
                    >
                      <Phone className="w-3 h-3" /> {s.phone}
                    </a>
                  )}
                  {s.email && (
                    <a
                      href={`mailto:${s.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-gray-600 inline-flex items-center gap-1 truncate"
                    >
                      <Mail className="w-3 h-3" /> {s.email}
                    </a>
                  )}
                </div>
              </Link>
              {canEdit && (
              <button
                onClick={() => remove(s.id)}
                disabled={busyId === s.id}
                className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
                title="Delete"
              >
                {busyId === s.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}