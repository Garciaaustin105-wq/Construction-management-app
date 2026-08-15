"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Pencil, Save, X, Droplets, MapPin } from "lucide-react";

// 1:1 property profile row on lawn_jobs (id == jobs.id). Rendered read-only as
// a compact card on the visit + schedule pages; office/PM can toggle an inline
// form to edit it. Saves upsert to lawn_jobs with organization_id resolved
// from the initial profile, or — if none exists yet — fetched from jobs before
// the write. Empty optional fields are sent as null (never "").

export type LawnJob = {
  id: string;
  organization_id: string | null;
  lot_sqft: number | null;
  gate_code: string | null;
  pets: string | null;
  access_notes: string | null;
  obstacles: string | null;
  sprinkler: boolean | null;
  map_lat: number | null;
  map_lng: number | null;
};

export default function LawnPropertyDetails({
  jobId,
  initial,
  canEdit,
}: {
  jobId: string;
  initial: LawnJob | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [profile, setProfile] = useState<LawnJob | null>(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // form draft state
  const [lotSqft, setLotSqft] = useState<string>(
    initial?.lot_sqft != null ? String(initial.lot_sqft) : ""
  );
  const [gateCode, setGateCode] = useState<string>(initial?.gate_code ?? "");
  const [pets, setPets] = useState<string>(initial?.pets ?? "");
  const [accessNotes, setAccessNotes] = useState<string>(
    initial?.access_notes ?? ""
  );
  const [obstacles, setObstacles] = useState<string>(initial?.obstacles ?? "");
  const [sprinkler, setSprinkler] = useState<boolean>(
    initial?.sprinkler ?? false
  );
  const [mapLat, setMapLat] = useState<string>(
    initial?.map_lat != null ? String(initial.map_lat) : ""
  );
  const [mapLng, setMapLng] = useState<string>(
    initial?.map_lng != null ? String(initial.map_lng) : ""
  );

  function numOrNull(s: string): number | null {
    if (s.trim() === "") return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function strOrNull(s: string): string | null {
    const t = s.trim();
    return t === "" ? null : t;
  }

  async function save() {
    setSaving(true);
    const supabase = createClient();

    // Resolve organization_id: prefer the existing profile, else read it from
    // jobs (lawn_jobs has no set_org_from_job trigger — app must send it).
    let organizationId = profile?.organization_id ?? null;
    if (!organizationId) {
      const { data: job } = await supabase
        .from("jobs")
        .select("organization_id")
        .eq("id", jobId)
        .maybeSingle();
      organizationId =
        (job as unknown as { organization_id: string | null } | null)
          ?.organization_id ?? null;
    }
    if (!organizationId) {
      toast.error("Could not resolve organization for this property");
      setSaving(false);
      return;
    }

    const row: LawnJob = {
      id: jobId,
      organization_id: organizationId,
      lot_sqft: numOrNull(lotSqft),
      gate_code: strOrNull(gateCode),
      pets: strOrNull(pets),
      access_notes: strOrNull(accessNotes),
      obstacles: strOrNull(obstacles),
      sprinkler,
      map_lat: numOrNull(mapLat),
      map_lng: numOrNull(mapLng),
    };

    const { error } = await supabase
      .from("lawn_jobs")
      .upsert(row, { onConflict: "id" });
    setSaving(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setProfile(row);
    setEditing(false);
    toast.success("Property details saved");
  }

  if (editing) {
    return (
      <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Property details</h2>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-gray-500 font-medium flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" />
            Cancel
          </button>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Lot sq ft</span>
          <input
            type="number"
            min={0}
            value={lotSqft}
            onChange={(e) => setLotSqft(e.target.value)}
            className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
            placeholder="8500"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Gate code</span>
          <input
            type="text"
            value={gateCode}
            onChange={(e) => setGateCode(e.target.value)}
            className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
            placeholder="#1234"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Pets</span>
          <input
            type="text"
            value={pets}
            onChange={(e) => setPets(e.target.value)}
            className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
            placeholder="Dog in yard — ring bell"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Access notes</span>
          <textarea
            value={accessNotes}
            onChange={(e) => setAccessNotes(e.target.value)}
            rows={2}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            placeholder="Key under mat, unlock side gate"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700">Obstacles</span>
          <textarea
            value={obstacles}
            onChange={(e) => setObstacles(e.target.value)}
            rows={2}
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
            placeholder="Sprinkler heads front-left, beehive near fence"
          />
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={sprinkler}
            onChange={(e) => setSprinkler(e.target.checked)}
            className="w-5 h-5"
          />
          <span className="text-sm font-medium text-gray-700">
            Sprinkler system (avoid overspray)
          </span>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Map lat</span>
            <input
              type="number"
              step="any"
              value={mapLat}
              onChange={(e) => setMapLat(e.target.value)}
              className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              placeholder="30.2672"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Map lng</span>
            <input
              type="number"
              step="any"
              value={mapLng}
              onChange={(e) => setMapLng(e.target.value)}
              className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              placeholder="-97.7431"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="w-full bg-green-600 text-white py-2.5 rounded-lg font-semibold text-sm active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    );
  }

  // Read-only card.
  const hasAny =
    !!profile &&
    (profile.gate_code ||
      profile.pets ||
      profile.access_notes ||
      profile.obstacles ||
      profile.lot_sqft != null ||
      profile.sprinkler ||
      profile.map_lat != null ||
      profile.map_lng != null);

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Property</h2>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-blue-600 font-medium flex items-center gap-1"
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </button>
        )}
      </div>

      {!hasAny ? (
        <p className="text-xs text-gray-400">
          No property details on file yet.
          {canEdit ? " Tap Edit to add gate code, pets, access notes, etc." : ""}
        </p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          {profile?.gate_code && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Gate code</dt>
              <dd className="text-gray-900 font-medium text-right">
                {profile.gate_code}
              </dd>
            </div>
          )}
          {profile?.pets && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Pets</dt>
              <dd className="text-gray-900 font-medium text-right">
                {profile.pets}
              </dd>
            </div>
          )}
          {profile?.access_notes && (
            <div>
              <dt className="text-gray-500">Access</dt>
              <dd className="text-gray-900 font-medium whitespace-pre-wrap">
                {profile.access_notes}
              </dd>
            </div>
          )}
          {profile?.obstacles && (
            <div>
              <dt className="text-gray-500">Obstacles</dt>
              <dd className="text-gray-900 font-medium whitespace-pre-wrap">
                {profile.obstacles}
              </dd>
            </div>
          )}
          {profile?.lot_sqft != null && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Lot sq ft</dt>
              <dd className="text-gray-900 font-medium text-right">
                {profile.lot_sqft.toLocaleString()}
              </dd>
            </div>
          )}
          {profile?.sprinkler && (
            <div className="flex items-center gap-1.5 text-green-700">
              <Droplets className="w-3.5 h-3.5" />
              <span className="text-xs font-medium">Sprinkler system</span>
            </div>
          )}
          {profile?.map_lat != null && profile?.map_lng != null && (
            <div className="flex items-center gap-1.5 text-gray-500 text-xs">
              <MapPin className="w-3.5 h-3.5" />
              <span>
                {profile.map_lat}, {profile.map_lng}
              </span>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}