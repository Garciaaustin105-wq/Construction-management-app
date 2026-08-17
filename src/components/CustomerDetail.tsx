"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2, Save, Phone, Mail, Briefcase, Building2 } from "lucide-react";
import { isLawn } from "@/lib/variant";

export type CustomerDetailRow = {
  id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  sms_opt_in: boolean | null;
  email_opt_in: boolean | null;
};

export type CustomerJob = { id: string; name: string; status: string };
export type CustomerSub = {
  id: string;
  company: string;
  trade: string | null;
  phone: string | null;
  email: string | null;
  job_name: string;
};

type Tab = "info" | "jobs" | "subs";

export default function CustomerDetail({
  customer,
  jobs,
  subs,
  canEdit = true,
}: {
  customer: CustomerDetailRow;
  jobs: CustomerJob[];
  subs: CustomerSub[];
  canEdit?: boolean;
}) {
  const supabase = createClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("info");

  const [name, setName] = useState(customer.name);
  const [contactName, setContactName] = useState(customer.contact_name ?? "");
  const [contactEmail, setContactEmail] = useState(customer.contact_email ?? "");
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [address, setAddress] = useState(customer.address ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [smsOptIn, setSmsOptIn] = useState(customer.sms_opt_in ?? false);
  const [emailOptIn, setEmailOptIn] = useState(customer.email_opt_in ?? true);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.warning("Customer name is required");
      return;
    }
    setSaving(true);
    const patch: Record<string, unknown> = {
      name: name.trim(),
      contact_name: contactName.trim() || null,
      contact_email: contactEmail.trim() || null,
      phone: phone.trim() || null,
      address: address.trim() || null,
      notes: notes.trim() || null,
    };
    // Only the lawn variant has the notification suite — write the opt-in flags
    // there so the construction form never touches them (both apps share one
    // DB; a customer could in principle be seen by both deploys).
    if (isLawn()) {
      patch.sms_opt_in = smsOptIn;
      patch.email_opt_in = emailOptIn;
    }
    const { error } = await supabase
      .from("customers")
      .update(patch)
      .eq("id", customer.id);
    setSaving(false);
    if (error) toast.error(`Failed: ${error.message}`);
    else toast.success("Saved");
  }

  // Subcontractors are a construction surface — don't show the "Subs" tab in
  // the lawn variant (the page also has no sub data there; this drops the label).
  const TABS: { key: Tab; label: string }[] = [
    { key: "info", label: "Info" },
    { key: "jobs", label: `Jobs (${jobs.length})` },
    ...(isLawn()
      ? []
      : [{ key: "subs" as Tab, label: `Subs (${subs.length})` }]),
  ];

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg p-4 shadow-sm">
        <p className="font-bold text-gray-900 flex items-center gap-1">
          <Building2 className="w-4 h-4 text-gray-400" />
          {customer.name}
        </p>
      </div>

      <div className="flex border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-2 text-sm font-medium ${
              tab === t.key ? "text-blue-600 border-b-2 border-blue-600" : "text-gray-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "info" &&
        (canEdit ? (
          <form onSubmit={save} className="bg-white rounded-lg p-4 shadow-sm space-y-3">
            <input
              type="text"
              placeholder="Customer / company name *"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="text"
              placeholder="Contact name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="email"
              placeholder="Contact email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="tel"
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="text"
              placeholder="Address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <textarea
              placeholder="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            {isLawn() && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-2">
                <p className="text-xs font-semibold text-green-800">
                  Customer notifications
                </p>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={emailOptIn}
                    onChange={(e) => setEmailOptIn(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-green-600"
                  />
                  <span>
                    <b>Email</b> — receive service updates by email (default on).
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={smsOptIn}
                    onChange={(e) => setSmsOptIn(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-green-600"
                  />
                  <span>
                    <b>Text (SMS)</b> — receive service updates by text. Only
                    enable with the customer&rsquo;s consent.
                  </span>
                </label>
              </div>
            )}
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save changes
            </button>
          </form>
        ) : (
          <div className="bg-white rounded-lg p-4 shadow-sm space-y-2 text-sm text-gray-700">
            {customer.contact_name && <p><span className="text-gray-400">Contact:</span> {customer.contact_name}</p>}
            {customer.contact_email && (
              <p className="inline-flex items-center gap-1"><Mail className="w-3 h-3 text-gray-400" /> {customer.contact_email}</p>
            )}
            {customer.phone && (
              <p className="inline-flex items-center gap-1"><Phone className="w-3 h-3 text-gray-400" /> {customer.phone}</p>
            )}
            {customer.address && <p><span className="text-gray-400">Address:</span> {customer.address}</p>}
            {customer.notes && <p className="whitespace-pre-wrap"><span className="text-gray-400">Notes:</span> {customer.notes}</p>}
            {!customer.contact_name && !customer.contact_email && !customer.phone && !customer.address && !customer.notes && (
              <p className="text-gray-400">No additional info.</p>
            )}
          </div>
        ))}

      {tab === "jobs" && (
        <div className="space-y-2">
          {jobs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">No jobs for this customer.</p>
          ) : (
            jobs.map((j) => (
              <Link
                key={j.id}
                href={`/jobs/${j.id}`}
                className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
              >
                <p className="font-medium text-gray-900 truncate">{j.name}</p>
                <p className="text-xs text-gray-500">{j.status}</p>
              </Link>
            ))
          )}
        </div>
      )}

      {tab === "subs" && (
        <div className="space-y-2">
          {subs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              No subcontractors attached to this customer&rsquo;s jobs.
            </p>
          ) : (
            subs.map((s) => (
              <Link
                key={`${s.id}-${s.job_name}`}
                href={`/admin/subcontractors/${s.id}`}
                className="block bg-white rounded-lg p-3 shadow-sm active:bg-gray-50"
              >
                <p className="font-medium text-gray-900 truncate flex items-center gap-1">
                  <Briefcase className="w-4 h-4 text-gray-400" />
                  {s.company}
                </p>
                {s.trade && <p className="text-xs text-blue-600 truncate">{s.trade}</p>}
                <p className="text-xs text-gray-400 truncate">on {s.job_name}</p>
                <div className="flex flex-col gap-0.5 mt-1">
                  {s.phone && (
                    <span className="text-xs text-gray-600 inline-flex items-center gap-1">
                      <Phone className="w-3 h-3" /> {s.phone}
                    </span>
                  )}
                  {s.email && (
                    <span className="text-xs text-gray-600 inline-flex items-center gap-1 truncate">
                      <Mail className="w-3 h-3" /> {s.email}
                    </span>
                  )}
                </div>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}