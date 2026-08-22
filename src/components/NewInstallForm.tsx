"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { SEVERITIES, type CustomerOption } from "@/lib/installs";

type Opt = { id: string; name: string };
type CrewOpt = { id: string; full_name: string | null; email: string; role: string };

// Office-side create form. Writes `installs` directly via the session client —
// RLS `office_manage_installs` (tier_office_or_pm) is what authorises it, and
// the BEFORE INSERT trigger stamps organization_id (from the parent job when
// one is chosen, otherwise from the organization_id sent here).
//
// Picking a customer auto-fills the install address + site contact from that
// customer's record and surfaces their service plan as a read-only reference,
// so the office doesn't retype info the customer directory already holds.
export default function NewInstallForm({
  orgId,
  installTypes,
  customers,
  jobs,
  crew,
}: {
  orgId: string;
  installTypes: Opt[];
  customers: CustomerOption[];
  jobs: Opt[];
  crew: CrewOpt[];
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  const [title, setTitle] = useState("");
  const [typeId, setTypeId] = useState(installTypes[0]?.id ?? "");
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [address, setAddress] = useState("");
  const [price, setPrice] = useState("");
  const [priority, setPriority] = useState("normal");
  const [poNumber, setPoNumber] = useState("");
  const [siteContactName, setSiteContactName] = useState("");
  const [siteContactPhone, setSiteContactPhone] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [duration, setDuration] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;

  function onCustomerChange(id: string) {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (!c) return;
    // Auto-fill only what isn't already typed, so manual entry wins. The address
    // is the one the office most often wants copied from the customer record.
    if (!address.trim() && c.address) setAddress(c.address);
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

    const { data, error } = await supabase
      .from("installs")
      .insert({
        organization_id: orgId,
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
        // datetime-local gives a local wall-clock string; new Date() reads it in
        // the browser's zone and toISOString() sends UTC, which is what
        // timestamptz wants.
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        duration_minutes: duration.trim() === "" ? null : Number(duration),
        assigned_crew: assigned,
        notes: notes.trim() || null,
      })
      .select("id")
      .single();

    if (error) {
      toast.error(`Failed: ${error.message}`);
      setSaving(false);
      return;
    }
    toast.success("Install scheduled");
    router.push(`/installs/${data.id}`);
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
            placeholder="Aerial drop — 12 Main St"
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
          {installTypes.length === 0 && (
            <span className="text-xs text-amber-700">
              No install types yet — add them in the database or ask for the seed
              file to be run.
            </span>
          )}
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
          <span className="text-xs font-medium text-gray-600">
            Attach to job (optional)
          </span>
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
            placeholder="Auto-filled from the customer, or type one"
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
            placeholder="0.00"
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
            placeholder="120"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <section className="bg-white rounded-lg p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Assign crew</h2>
        <p className="text-xs text-gray-500 mb-3">
          Only assigned crew can see this install and record work on it.
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
          {crew.length === 0 && (
            <p className="text-sm text-amber-700 bg-amber-50 p-3 rounded">
              No crew or superintendents found to assign.
            </p>
          )}
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
        {saving ? "Saving..." : "Schedule Install"}
      </button>
    </div>
  );
}