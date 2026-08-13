"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";

type Org = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
};

export default function OrgSettingsForm({
  org,
  canEdit,
}: {
  org: Org;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [address, setAddress] = useState(org.address ?? "");
  const [phone, setPhone] = useState(org.phone ?? "");
  const [email, setEmail] = useState(org.email ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch("/api/org", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization_id: org.id,
        name,
        address: address || null,
        phone: phone || null,
        email: email || null,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(data.error ?? "Save failed");
      return;
    }
    toast.success("Organization updated");
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2">
          Organization
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md mx-auto p-4">
        {canEdit ? (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-lg p-4 shadow-sm space-y-4"
          >
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Business name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Address</span>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Phone</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              />
            </label>
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? "Saving..." : "Save"}
            </button>
          </form>
        ) : (
          <div className="bg-white rounded-lg p-4 shadow-sm space-y-2 text-sm">
            <p className="font-semibold text-gray-900 text-base">{name}</p>
            {address && <p className="text-gray-600">{address}</p>}
            {phone && <p className="text-gray-600">{phone}</p>}
            {email && <p className="text-gray-600">{email}</p>}
            <p className="text-xs text-gray-400 pt-2">
              You can view but not edit the organization profile.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}