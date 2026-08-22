"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { SEVERITIES, type CustomerOption } from "@/lib/installs";
import InstallStatusControl from "@/components/InstallStatusControl";

type Opt = { id: string; name: string };
type CrewOpt = { id: string; full_name: string | null; email: string; role: string };
type Install = {
  id: string;
  job_id: string | null;
  customer_id: string | null;
  install_type_id: string | null;
  title: string;
  status: string;
  completion_outcome: string | null;
  price: number | string | null;
  address: string | null;
  priority: string | null;
  po_number: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  assigned_crew: string[] | null;
  notes: string | null;
};

// `datetime-local` wants "YYYY-MM-DDTHH:mm" in LOCAL time, but the column is a
// timestamptz that arrives as UTC ISO. Converting via the local getters (rather
// than slicing the ISO string) is what keeps a 9am appointment showing as 9am
// instead of jumping by the timezone offset — the exact bug a naive
// `.slice(0,16)` introduces.
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export default function EditInstallForm({
  install,
  installTypes,
  customers,
  jobs,
  crew,
}: {
  install: Install;
  installTypes: Opt[];
  customers: CustomerOption[];
  jobs: Opt[];
  crew: CrewOpt[];
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  const [title, setTitle] = useState(install.title);
  const [typeId, setTypeId] = useState(install.install_type_id ?? "");
  const [customerId, setCustomerId] = useState(install.customer_id ?? "");
  const [jobId, setJobId] = useState(install.job_id ?? "");
  const [address, setAddress] = useState(install.address ?? "");
  const [price, setPrice] = useState(
    install.price == null ? "" : String(Number(install.price))
  );
  const [priority, setPriority] = useState(install.priority ?? "normal");
  const [poNumber, setPoNumber] = useState(install.po_number ?? "");
  const [siteContactName, setSiteContactName] = useState(
    install.site_contact_name ?? ""
  );
  const [siteContactPhone, setSiteContactPhone] = useState(
    install.site_contact_phone ?? ""
  );
  const [scheduledAt, setScheduledAt] = useState(
    toLocalInputValue(install.scheduled_at)
  );
  const [duration, setDuration] = useState(
    install.duration_minutes == null ? "" : String(install.duration_minutes)
  );
  const [assigned, setAssigned] = useState<string[]>(install.assigned_crew ?? []);
  const [notes, setNotes] = useState(install.notes ?? "");
  const [saving, setSaving] = useState(false);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;

  function onCustomerChange(id: string) {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (!c) return;
    // On edit, only fill site contact if it's blank — the address is NOT
    // touched here because it may have been customised for this install.
    if (!siteContactName.trim() && c.contact_name) setSiteContactName(c.contact_name);
    if (!siteContactPhone.trim() && c.phone) setSiteContactPhone(c.phone);
  }

  function toggleCrew(id: string) {
    setAssigned((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    if (!title.trim()) {
      toast.error("Give the install a title");
      return;
    }
    const priceNum = price.trim() === "" ? 0 : Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Price must be a number, 0 or more");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("installs")
      .update({
        title: title.trim(),
        install_type_id: typeId || null,
        customer_id: customerId || null,
        job_id: jobId || null,
        address: address.trim() || null,
        price: priceNum,
        priority: priority || "normal",
        po_number: poNumber.trim() || null,
        site_contact_name: siteContactName.trim() || null,
        site_contact_phone: siteContactPhone.trim() || null,
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        duration_minutes: duration.trim() === "" ? null : Number(duration),
        assigned_crew: assigned,
        notes: notes.trim() || null,
      })
      .eq("id", install.id);

    if (error) {
      toast.error(`Failed: ${error.message}`);
      setSaving(false);
      return;
    }
    toast.success("Install updated");
    router.push(`/installs/${install.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Title *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Install type</span>
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">— none —</option>
            {installTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <div>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Customer</span>
            <select
              value={customerId}
              onChange={(e) => onCustomerChange(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">— none —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {selectedCustomer && (
            <div className="mt-1.5 rounded-lg bg-gray-50 border border-gray-200 p-2 text-xs text-gray-600 space-y-0.5">
              {selectedCustomer.service_plan && (
                <p>
                  <span className="text-gray-400">Plan:</span>{" "}
                  {selectedCustomer.service_plan}
                </p>
              )}
              {selectedCustomer.contact_email && (
                <p>
                  <span className="text-gray-400">Email:</span>{" "}
                  {selectedCustomer.contact_email}
                </p>
              )}
              {selectedCustomer.phone && (
                <p>
                  <span className="text-gray-400">Phone:</span>{" "}
                  {selectedCustomer.phone}
                </p>
              )}
            </div>
          )}
          <Link
            href="/admin/customers"
            className="mt-1 inline-block text-xs font-medium text-blue-600"
          >
            + New customer
          </Link>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Attached job</span>
          <select
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">— standalone install —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Address</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">Priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            PO / reference #
          </span>
          <input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            placeholder="Optional"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">
              Site contact
            </span>
            <input
              value={siteContactName}
              onChange={(e) => setSiteContactName(e.target.value)}
              placeholder="On-site name"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-gray-600">
              Contact phone
            </span>
            <input
              type="tel"
              value={siteContactPhone}
              onChange={(e) => setSiteContactPhone(e.target.value)}
              placeholder="On-site phone"
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Price</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Scheduled for</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Expected duration (minutes)
          </span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Assigned crew</h2>
        <p className="text-xs text-gray-500 mb-3">
          Removing someone hides the install from them and stops them recording
          any more work on it. Time and notes they already logged are kept.
        </p>
        <div className="space-y-2">
          {crew.map((c) => (
            <label
              key={c.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 active:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={assigned.includes(c.id)}
                onChange={() => toggleCrew(c.id)}
                className="w-5 h-5"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {c.full_name ?? c.email}
                </p>
                <p className="text-xs text-gray-500 truncate">{c.email}</p>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">
            Office notes (crew can read, not edit)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-blue-600 text-white py-4 rounded-lg font-semibold text-base active:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save changes"}
      </button>

      {/* Status lives in a shared control so the detail page and this form
          enforce the same invariant (a finished status always carries an
          outcome + completed_at). See InstallStatusControl.tsx. */}
      <InstallStatusControl
        installId={install.id}
        status={install.status}
        completionOutcome={install.completion_outcome}
        canEdit
      />
    </div>
  );
}