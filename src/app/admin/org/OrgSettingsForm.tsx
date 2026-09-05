"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Upload, Trash2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { createClient } from "@/lib/supabase/client";
import AddressInput from "@/components/AddressInput";
import { invalidateOrgBranding } from "@/lib/useOrgBranding";
import { validateUpload } from "@/lib/uploadValidate";

type Org = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logo_path: string | null;
  default_labor_rate: number | null;
  default_labor_cost_rate: number | null;
  default_mobilization_hours: number | null;
};

export default function OrgSettingsForm({
  org,
  canEdit,
  isLawn,
}: {
  org: Org;
  canEdit: boolean;
  // Landscape labor defaults are lawn-only; a construction org has no use for
  // them. Passed from the page rather than looked up here.
  isLawn: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [address, setAddress] = useState(org.address ?? "");
  const [phone, setPhone] = useState(org.phone ?? "");
  const [email, setEmail] = useState(org.email ?? "");
  // Held as STRINGS: an empty box must mean "not set", which a number-typed
  // state cannot express distinctly from 0.
  const [laborRate, setLaborRate] = useState(org.default_labor_rate?.toString() ?? "");
  const [laborCostRate, setLaborCostRate] = useState(org.default_labor_cost_rate?.toString() ?? "");
  const [mobilizationHours, setMobilizationHours] = useState(
    org.default_mobilization_hours?.toString() ?? ""
  );
  const [logoPath, setLogoPath] = useState<string | null>(org.logo_path);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();
  const logoUrl = logoPath ? supabase.storage.from("org-logos").getPublicUrl(logoPath).data.publicUrl : null;

  // The API takes numbers or null, never numeric strings — a "65" is a 400.
  // An empty box means "not set" (null), which is different from 0: zero
  // mobilization hours is a real answer, null means nobody estimated it.
  const numOrNull = (v: string): number | null => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

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
        default_labor_rate: numOrNull(laborRate),
        default_labor_cost_rate: numOrNull(laborCostRate),
        default_mobilization_hours: numOrNull(mobilizationHours),
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(data.error ?? "Save failed");
      return;
    }
    toast.success("Organization updated");
    router.push("/dashboard");
  }

  async function handleLogoUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = logoRef.current?.files?.[0];
    if (!file) {
      toast.warning("Pick an image first");
      return;
    }
    const v = validateUpload(file, "image");
    if (!v.ok) {
      toast.error(v.error);
      return;
    }
    setUploading(true);
    const ext = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    }[file.type] || "img";
    const oldPath = logoPath;
    const path = `${org.id}/logo-${crypto.randomUUID()}.${ext}`;
    const { error: upError } = await supabase.storage.from("org-logos").upload(path, file, { upsert: false });
    if (upError) {
      toast.error(`Upload failed: ${upError.message}`);
      setUploading(false);
      return;
    }
    const res = await fetch("/api/org", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization_id: org.id,
        logo_path: path,
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error ?? "Save failed");
      setUploading(false);
      return;
    }
    setLogoPath(path);
    invalidateOrgBranding();
    if (oldPath && oldPath !== path) {
      void supabase.storage.from("org-logos").remove([oldPath]);
    }
    if (logoRef.current) logoRef.current.value = "";
    toast.success("Logo updated");
    setUploading(false);
  }

  async function handleLogoRemove() {
    const path = logoPath;
    if (!path) return;
    const res = await fetch("/api/org", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization_id: org.id,
        logo_path: null,
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error ?? "Failed");
      return;
    }
    setLogoPath(null);
    invalidateOrgBranding();
    void supabase.storage.from("org-logos").remove([path]);
    toast.success("Logo removed");
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-blue-600 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate">
          Organization
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        {canEdit ? (
          <form
            onSubmit={handleSubmit}
            className="bg-white rounded-lg p-4 shadow-sm space-y-4"
          >
            <div className="rounded-lg border border-gray-200 p-3 space-y-2">
              <span className="text-sm font-medium text-gray-700">Logo</span>
              <p className="text-xs text-gray-500">Shown in the app header and on estimates you send to customers. PNG, JPG, or WebP.</p>
              {logoUrl ? (
                <div className="flex items-center gap-3">
                  {/* Public storage URL (getPublicUrl, no rotating token), so
                      the optimizer caches it — worth a real <Image>. w/h are the
                      max box; object-contain letterboxes any logo aspect. */}
                  <Image src={logoUrl} alt="Logo" width={180} height={48} className="h-12 w-auto max-w-[180px] object-contain rounded border border-gray-100" />
                  <button type="button" onClick={handleLogoRemove} className="text-xs text-red-600 font-semibold flex items-center gap-1"><Trash2 className="w-4 h-4" /> Remove</button>
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic">No logo set — the default Terra Vista icon is shown.</p>
              )}
              <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="block w-full text-sm text-gray-900 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-semibold" />
              <button type="button" onClick={handleLogoUpload} disabled={uploading} className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? "Uploading..." : "Upload logo"}
              </button>
            </div>
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
              <AddressInput
                value={address}
                onChange={setAddress}
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
            {isLawn && (
              <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                <span className="text-sm font-medium text-gray-700">Landscape labor defaults</span>
                <p className="text-xs text-gray-500">These prefill a new estimate. You can change them per job.</p>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Billed rate</span>
                  <span className="block text-xs text-gray-500">per man-hour, what the customer pays</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="Not set"
                    value={laborRate}
                    onChange={(e) => setLaborRate(e.target.value)}
                    className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Your cost</span>
                  <span className="block text-xs text-gray-500">per man-hour, burdened. Internal only, never shown to a customer</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="Not set"
                    value={laborCostRate}
                    onChange={(e) => setLaborCostRate(e.target.value)}
                    className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Mobilization</span>
                  <span className="block text-xs text-gray-500">MAN-hours per job: drive both ways, unload, setup, cleanup, haul-off. Two people driving 30 min each way is 2 man-hours.</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="Not set"
                    value={mobilizationHours}
                    onChange={(e) => setMobilizationHours(e.target.value)}
                    className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2"
                  />
                </label>
              </div>
            )}
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
            {logoUrl && (
              <Image src={logoUrl} alt="Logo" width={180} height={48} className="h-12 w-auto max-w-[180px] object-contain rounded border border-gray-100" />
            )}
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