"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import AddressInput from "@/components/AddressInput";
import { useToast } from "@/components/Toast";
import { Plus, Trash2, Loader2, Phone, Mail, Building2 } from "lucide-react";

export type Customer = {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
};

// Customer contact directory — mirrors SubcontractorsManager: an add form plus
// a list of rows linking to the detail page. Unlike subs, customers have no
// storage bucket, so delete is just the row — but we guard against deleting a
// customer that still has jobs (jobs.customer_id is ON DELETE SET NULL, which
// would silently detach it; we block and ask the office to reassign first).
export default function CustomersManager({
  initial,
  canEdit = true,
  orgId,
}: {
  initial: Customer[];
  canEdit?: boolean;
  orgId: string;
}) {
  const supabase = createClient();
  const toast = useToast();
  const [customers, setCustomers] = useState<Customer[]>(initial);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");

  async function refresh() {
    const { data } = await supabase
      .from("customers")
      .select(
        "id, name, contact_name, contact_email, phone, address, notes"
      )
      .order("name");
    setCustomers((data as Customer[]) ?? []);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.warning("Customer name is required");
      return;
    }
    setAdding(true);
    const { error } = await supabase.from("customers").insert({
      name: name.trim(),
      contact_name: contactName.trim() || null,
      contact_email: contactEmail.trim() || null,
      phone: phone.trim() || null,
      address: address.trim() || null,
      organization_id: orgId,
    });
    setAdding(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    toast.success("Customer added");
    setName("");
    setContactName("");
    setContactEmail("");
    setPhone("");
    setAddress("");
    await refresh();
  }

  async function remove(id: string) {
    setBusyId(id);
    // Guard: block deleting a customer that still has jobs. The FK is
    // ON DELETE SET NULL, so a hard delete would silently detach the customer
    // from those jobs — make the office reassign explicitly instead.
    const { data: linked } = await supabase
      .from("jobs")
      .select("id")
      .eq("customer_id", id)
      .limit(1);
    setBusyId(null);
    if (linked && linked.length > 0) {
      toast.error(
        "This customer has jobs — reassign or remove the customer from those jobs before deleting."
      );
      return;
    }
    if (!confirm("Delete this customer?")) return;
    setBusyId(id);
    const { error } = await supabase.from("customers").delete().eq("id", id);
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
      {/* Add form — office/admin only */}
      {canEdit && (
        <form
          onSubmit={add}
          className="bg-white rounded-lg p-4 shadow-sm space-y-3"
        >
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1">
            <Plus className="w-4 h-4" /> Add Customer
          </h2>
          <input
            type="text"
            placeholder="Customer / company name *"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
              type="tel"
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <input
            type="email"
            placeholder="Contact email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <AddressInput
            placeholder="Address"
            value={address}
            onChange={setAddress}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            type="submit"
            disabled={adding}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {adding ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            Add
          </button>
        </form>
      )}

      {/* List */}
      <div className="space-y-2">
        {customers.length === 0 && (
          <p className="text-sm text-gray-500 text-center py-6">
            No customers yet.
          </p>
        )}
        {customers.map((c) => (
          <div key={c.id} className="bg-white rounded-lg p-3 shadow-sm relative">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-gray-900 truncate flex items-center gap-1">
                  <Building2 className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  {c.name}
                </p>
                {c.contact_name && (
                  <p className="text-xs text-gray-500 truncate">
                    {c.contact_name}
                  </p>
                )}
                {c.address && (
                  <p className="text-xs text-gray-400 truncate">{c.address}</p>
                )}
                <div className="flex flex-col gap-0.5 mt-1">
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-gray-600 inline-flex items-center gap-1 relative z-10"
                    >
                      <Phone className="w-3 h-3" /> {c.phone}
                    </a>
                  )}
                  {c.contact_email && (
                    <a
                      href={`mailto:${c.contact_email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-gray-600 inline-flex items-center gap-1 truncate relative z-10"
                    >
                      <Mail className="w-3 h-3" /> {c.contact_email}
                    </a>
                  )}
                </div>
              </div>
              {/* Stretched link overlay: makes the whole card navigate to the
                  detail page. The tel:/mailto: anchors + delete button carry
                  relative z-10 so they stay independently clickable (HTML
                  forbids <a> inside <a>, so the card link is an overlay, not a
                  wrapper). */}
              <Link
                href={`/admin/customers/${c.id}`}
                className="absolute inset-0"
                aria-label={c.name}
              />
              {canEdit && (
                <button
                  onClick={() => remove(c.id)}
                  disabled={busyId === c.id}
                  className="text-red-600 p-1 rounded hover:bg-red-50 disabled:opacity-50 flex-shrink-0 relative z-10"
                  title="Delete"
                >
                  {busyId === c.id ? (
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