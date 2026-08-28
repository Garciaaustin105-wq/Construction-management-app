/**
 * SchedulingTools
 *
 * A single page component for lawn scheduling ops: weather auto‑reschedule,
 * batch reschedule, blackout dates, service zones, and crew time‑off.
 * Uses the Supabase client in the browser and router.refresh() after each
 * mutation. All toasts are handled via the shared ToastProvider.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { loadGoogleMaps } from "@/lib/googleMaps";

export type SchedulingCrew = {
  id: string;
  name: string;
  working_days: number[] | null;
  max_visits_per_day: number | null;
};
export type SchedulingBlackout = { id: string; date: string; reason: string | null };
export type SchedulingZone = {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
  assigned_day_of_week: number | null;
  default_crew_id: string | null;
  active: boolean;
};
export type SchedulingTimeOff = {
  id: string;
  crew_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
};
export type SchedulingProps = {
  orgId: string;
  weather: { enabled: boolean; lat: number | null; lng: number | null };
  crews: SchedulingCrew[];
  blackouts: SchedulingBlackout[];
  zones: SchedulingZone[];
  timeOff: SchedulingTimeOff[];
};

export type SchedulingToolsProps = SchedulingProps;

export default function SchedulingTools(
  props: SchedulingToolsProps
): React.ReactElement {
  const { orgId, weather, crews, blackouts, zones, timeOff } = props;
  const toast = useToast();
  const router = useRouter();

  // Busy state keyed by action id
  const [busyId, setBusyId] = useState<string | null>(null);

  // Section 1: Weather
  const [weatherEnabled, setWeatherEnabled] = useState(weather.enabled);
  const [weatherLat, setWeatherLat] = useState(weather.lat ?? "");
  const [weatherLng, setWeatherLng] = useState(weather.lng ?? "");
  const [weatherAddress, setWeatherAddress] = useState("");

  // Section 2: Batch reschedule
  const [batchFrom, setBatchFrom] = useState("");
  const [batchTo, setBatchTo] = useState("");
  const [batchReason, setBatchReason] = useState("weather");
  const [batchCrewId, setBatchCrewId] = useState<string | null>(null);

  // Section 3: Blackouts
  const [blackoutDate, setBlackoutDate] = useState("");
  const [blackoutReason, setBlackoutReason] = useState("");

  // Section 4: Service zones
  const [zoneName, setZoneName] = useState("");
  const [zoneAddress, setZoneAddress] = useState("");
  const [zoneLat, setZoneLat] = useState<number | null>(null);
  const [zoneLng, setZoneLng] = useState<number | null>(null);
  const [zoneRadius, setZoneRadius] = useState(5);
  const [zoneAssignedDay, setZoneAssignedDay] = useState<number | null>(null);
  const [zoneDefaultCrew, setZoneDefaultCrew] = useState<string | null>(null);

  // Section 5: Crew time off
  const [timeOffCrew, setTimeOffCrew] = useState<string | null>(null);
  const [timeOffStart, setTimeOffStart] = useState("");
  const [timeOffEnd, setTimeOffEnd] = useState("");
  const [timeOffReason, setTimeOffReason] = useState("");

  // Helper: load supabase client
  const loadSupabase = async () => {
    const supabaseMod = await import("@/lib/supabase/client");
    return supabaseMod.createClient();
  };

  // Helper: error message extraction (no `any` leaks)
  const errMsg = (e: unknown): string =>
    e instanceof Error ? e.message : "Something went wrong";

  // Helper: geocode an address into the given section's lat/lng inputs.
  // target keeps the weather and zone sections independent — one geocode
  // must never fill the other's coordinates.
  const geocodeAddress = async (address: string, target: "weather" | "zone") => {
    if (!address.trim()) {
      toast.error("Enter an address to geocode");
      return;
    }
    setBusyId(`geocode-${target}`);
    try {
      const google = await loadGoogleMaps();
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ address }, (results, status) => {
        if (status === "OK" && results && results[0]) {
          const loc = results[0].geometry.location;
          if (target === "weather") {
            setWeatherLat(loc.lat());
            setWeatherLng(loc.lng());
          } else {
            setZoneLat(loc.lat());
            setZoneLng(loc.lng());
          }
          setBusyId(null);
          toast.success("Location found");
        } else {
          setBusyId(null);
          toast.error("Address not found");
        }
      });
    } catch (e) {
      setBusyId(null);
      toast.error(errMsg(e) || "Geocoding failed");
    }
  };

  // Section 1: Save weather settings
  const handleWeatherSave = async () => {
    setBusyId("weatherSave");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("organizations")
        .update({
          auto_weather_reschedule_enabled: weatherEnabled,
          service_area_lat: weatherLat === "" ? null : Number(weatherLat),
          service_area_lng: weatherLng === "" ? null : Number(weatherLng),
        })
        .eq("id", orgId);
      if (error) throw error;
      toast.success("Weather settings updated");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to update weather settings");
    } finally {
      setBusyId(null);
    }
  };

  // Section 2: Run batch reschedule
  const handleBatchRun = async () => {
    if (!batchFrom || !batchTo) {
      toast.error("From and To dates are required");
      return;
    }
    const fromDate = new Date(batchFrom);
    const toDate = new Date(batchTo);
    if (toDate < fromDate) {
      toast.error("To date must be after From date");
      return;
    }
    const daysDiff = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 1) {
      if (!confirm("This range spans more than one day. Proceed?")) return;
    }
    setBusyId("batchRun");
    try {
      const supabase = await loadSupabase();
      const { data, error } = await supabase.rpc("batch_reschedule_visits", {
        p_org_id: orgId,
        p_from_date: batchFrom,
        p_to_date: batchTo,
        p_crew_id: batchCrewId || null,
        p_reason: batchReason || "weather",
      });
      if (error) throw error;
      const res = data?.[0];
      if (!res) throw new Error("No result");
      toast.success(
        `Rescheduled ${res.rescheduled_count} visits, skipped ${res.skipped_capacity_count} (capacity)`
      );
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Batch reschedule failed");
    } finally {
      setBusyId(null);
    }
  };

  // Section 3: Add blackout
  const handleAddBlackout = async () => {
    if (!blackoutDate) {
      toast.error("Date is required");
      return;
    }
    if (blackouts.some((b) => b.date === blackoutDate)) {
      toast.warning("Date already exists");
      return;
    }
    setBusyId("addBlackout");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("org_blackout_dates")
        .insert({
          organization_id: orgId,
          date: blackoutDate,
          reason: blackoutReason || null,
        });
      if (error) throw error;
      toast.success("Blackout added");
      setBlackoutDate("");
      setBlackoutReason("");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to add blackout");
    } finally {
      setBusyId(null);
    }
  };

  // Section 3: Delete blackout
  const handleDeleteBlackout = async (id: string) => {
    if (!confirm("Delete this blackout date?")) return;
    setBusyId(`delBlackout-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("org_blackout_dates")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Blackout deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to delete blackout");
    } finally {
      setBusyId(null);
    }
  };

  // Section 4: Add zone
  const handleAddZone = async () => {
    if (!zoneName.trim()) {
      toast.error("Zone name is required");
      return;
    }
    if (zoneLat === null || zoneLng === null) {
      toast.error("Geocode an address first");
      return;
    }
    setBusyId("addZone");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("service_zones")
        .insert({
          organization_id: orgId,
          name: zoneName,
          center_lat: zoneLat,
          center_lng: zoneLng,
          radius_miles: zoneRadius,
          assigned_day_of_week: zoneAssignedDay,
          default_crew_id: zoneDefaultCrew,
          active: true,
        });
      if (error) throw error;
      toast.success("Zone added");
      setZoneName("");
      setZoneAddress("");
      setZoneLat(null);
      setZoneLng(null);
      setZoneRadius(5);
      setZoneAssignedDay(null);
      setZoneDefaultCrew(null);
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to add zone");
    } finally {
      setBusyId(null);
    }
  };

  // Section 4: Delete zone
  const handleDeleteZone = async (id: string) => {
    if (!confirm("Delete this zone?")) return;
    setBusyId(`delZone-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("service_zones")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Zone deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to delete zone");
    } finally {
      setBusyId(null);
    }
  };

  // Section 5: Add time off
  const handleAddTimeOff = async () => {
    if (!timeOffCrew) {
      toast.error("Crew is required");
      return;
    }
    if (!timeOffStart) {
      toast.error("Start date is required");
      return;
    }
    let start = new Date(timeOffStart);
    let end = timeOffEnd ? new Date(timeOffEnd) : start;
    if (end < start) {
      // swap
      const tmp = start;
      start = end;
      end = tmp;
      toast.warning("End date was before start; swapped");
    }
    setBusyId("addTimeOff");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("crew_time_off")
        .insert({
          organization_id: orgId,
          crew_id: timeOffCrew,
          start_date: start.toISOString().split("T")[0],
          end_date: end.toISOString().split("T")[0],
          reason: timeOffReason || null,
        });
      if (error) throw error;
      toast.success("Time off added");
      setTimeOffCrew(null);
      setTimeOffStart("");
      setTimeOffEnd("");
      setTimeOffReason("");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to add time off");
    } finally {
      setBusyId(null);
    }
  };

  // Section 5: Delete time off
  const handleDeleteTimeOff = async (id: string) => {
    if (!confirm("Delete this time off entry?")) return;
    setBusyId(`delTimeOff-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("crew_time_off")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Time off deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e) || "Failed to delete time off");
    } finally {
      setBusyId(null);
    }
  };

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="space-y-6">
      {/* Section 1 – Automatic weather reschedule */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Automatic weather reschedule</h3>
        <p className="text-sm text-gray-600 mb-4">
          When on, a nightly check moves pending visits off high‑rain days
          automatically (uses NWS forecast for your service area).
        </p>
        <div className="flex items-center gap-2 mb-4">
          <input
            type="checkbox"
            checked={weatherEnabled}
            onChange={(e) => setWeatherEnabled(e.target.checked)}
            id="weather-enabled"
          />
          <label htmlFor="weather-enabled" className="text-sm">
            Enable auto‑reschedule
          </label>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Latitude</label>
            <NumberInput
              value={weatherLat === "" ? 0 : Number(weatherLat)}
              onChange={(n) => setWeatherLat(n === 0 ? "" : n)}
              placeholder="Latitude"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Longitude</label>
            <NumberInput
              value={weatherLng === "" ? 0 : Number(weatherLng)}
              onChange={(n) => setWeatherLng(n === 0 ? "" : n)}
              placeholder="Longitude"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mb-4">
          <input
            type="text"
            value={weatherAddress}
            onChange={(e) => setWeatherAddress(e.target.value)}
            placeholder="Address to geocode"
            className="flex-1 border border-gray-300 rounded-lg px-2 py-1 text-sm"
          />
          <button
            onClick={() => geocodeAddress(weatherAddress, "weather")}
            disabled={busyId === "geocode-weather"}
            className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
          >
            {busyId === "geocode-weather" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Geocode
          </button>
        </div>
        <button
          onClick={handleWeatherSave}
          disabled={busyId === "weatherSave"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "weatherSave" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Save
        </button>
        <p className="text-sm text-gray-600 mt-4">
          Manual same‑day moves live at{" "}
          <a href="/lawn/weather" className="text-blue-600 hover:underline">
            Weather board
          </a>
        </p>
      </div>

      {/* Section 2 – Batch reschedule */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Batch reschedule</h3>
        <p className="text-sm text-gray-600 mb-4">
          Move all pending visits in a date range to a later date. Respects each
          crew&apos;s daily capacity — overflow visits are skipped and counted.
        </p>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">From date</label>
            <input
              type="date"
              value={batchFrom}
              onChange={(e) => setBatchFrom(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">To date</label>
            <input
              type="date"
              value={batchTo}
              onChange={(e) => setBatchTo(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Reason</label>
            <input
              type="text"
              value={batchReason}
              onChange={(e) => setBatchReason(e.target.value)}
              placeholder="weather"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Crew filter</label>
            <select
              value={batchCrewId ?? ""}
              onChange={(e) =>
                setBatchCrewId(e.target.value === "" ? null : e.target.value)
              }
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">All crews</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          onClick={handleBatchRun}
          disabled={busyId === "batchRun"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "batchRun" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Run
        </button>
      </div>

      {/* Section 3 – Blackout dates */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Blackout dates</h3>
        <p className="text-sm text-gray-600 mb-4">
          No visits are scheduled or moved onto these dates.
        </p>
        <ul className="space-y-2 mb-4">
          {blackouts.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between bg-gray-50 rounded-lg p-2"
            >
              <div>
                <p className="text-sm font-medium">{b.date}</p>
                <p className="text-sm text-gray-500">
                  {b.reason ?? "—"}
                </p>
              </div>
              <button
                onClick={() => handleDeleteBlackout(b.id)}
                disabled={busyId === `delBlackout-${b.id}`}
                className="text-red-600 hover:text-red-800 flex items-center gap-1"
              >
                {busyId === `delBlackout-${b.id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Date</label>
            <input
              type="date"
              value={blackoutDate}
              onChange={(e) => setBlackoutDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Reason</label>
            <input
              type="text"
              value={blackoutReason}
              onChange={(e) => setBlackoutReason(e.target.value)}
              placeholder="Optional"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <button
          onClick={handleAddBlackout}
          disabled={busyId === "addBlackout"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addBlackout" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>

      {/* Section 4 – Service zones */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Service zones</h3>
        <p className="text-sm text-gray-600 mb-4">
          Named circles used to group properties. Assigned day + default crew are
          hints used when scheduling new work.
        </p>
        <ul className="space-y-2 mb-4">
          {zones.map((z) => (
            <li
              key={z.id}
              className="flex items-center justify-between bg-gray-50 rounded-lg p-2"
            >
              <div>
                <p className="text-sm font-medium">{z.name}</p>
                <p className="text-sm text-gray-500">
                  Radius: {z.radius_miles} mi
                </p>
                <p className="text-sm text-gray-500">
                  Day:{" "}
                  {z.assigned_day_of_week !== null
                    ? DOW[z.assigned_day_of_week]
                    : "—"}
                </p>
                <p className="text-sm text-gray-500">
                  Crew:{" "}
                  {crews.find((c) => c.id === z.default_crew_id)?.name ??
                    "—"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded text-xs ${
                    z.active ? "bg-green-200 text-green-800" : "bg-gray-200 text-gray-800"
                  }`}
                >
                  {z.active ? "Active" : "Inactive"}
                </span>
                <button
                  onClick={() => handleDeleteZone(z.id)}
                  disabled={busyId === `delZone-${z.id}`}
                  className="text-red-600 hover:text-red-800 flex items-center gap-1"
                >
                  {busyId === `delZone-${z.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              placeholder="Zone name *"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Address</label>
            <input
              type="text"
              value={zoneAddress}
              onChange={(e) => setZoneAddress(e.target.value)}
              placeholder="Address to geocode"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Radius (mi)</label>
            <NumberInput
              value={zoneRadius}
              onChange={(n) => setZoneRadius(n)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Assigned day</label>
            <select
              value={zoneAssignedDay ?? ""}
              onChange={(e) =>
                setZoneAssignedDay(
                  e.target.value === "" ? null : Number(e.target.value)
                )
              }
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">None</option>
              {DOW.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Default crew</label>
            <select
              value={zoneDefaultCrew ?? ""}
              onChange={(e) =>
                setZoneDefaultCrew(e.target.value === "" ? null : e.target.value)
              }
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">None</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Geocode</label>
            <button
              onClick={() => geocodeAddress(zoneAddress, "zone")}
              disabled={busyId === "geocode-zone"}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
            >
              {busyId === "geocode-zone" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Geocode
            </button>
          </div>
        </div>
        <button
          onClick={handleAddZone}
          disabled={busyId === "addZone"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addZone" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>

      {/* Section 5 – Crew time off */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Crew time off</h3>
        <p className="text-sm text-gray-600 mb-4">
          Dates a crew is unavailable — capacity checks skip these.
        </p>
        {crews.map((c) => (
          <div key={c.id} className="mb-4">
            <h4 className="font-medium mb-2">{c.name}</h4>
            <ul className="space-y-2 mb-2">
              {timeOff
                .filter((t) => t.crew_id === c.id)
                .map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between bg-gray-50 rounded-lg p-2"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {t.start_date} – {t.end_date}
                      </p>
                      <p className="text-sm text-gray-500">
                        {t.reason ?? "—"}
                      </p>
                    </div>
                    <button
                      onClick={() => handleDeleteTimeOff(t.id)}
                      disabled={busyId === `delTimeOff-${t.id}`}
                      className="text-red-600 hover:text-red-800 flex items-center gap-1"
                    >
                      {busyId === `delTimeOff-${t.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      Delete
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Crew</label>
            <select
              value={timeOffCrew ?? ""}
              onChange={(e) =>
                setTimeOffCrew(e.target.value === "" ? null : e.target.value)
              }
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select crew *</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Start date</label>
            <input
              type="date"
              value={timeOffStart}
              onChange={(e) => setTimeOffStart(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">End date</label>
            <input
              type="date"
              value={timeOffEnd}
              onChange={(e) => setTimeOffEnd(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Reason</label>
            <input
              type="text"
              value={timeOffReason}
              onChange={(e) => setTimeOffReason(e.target.value)}
              placeholder="Optional"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <button
          onClick={handleAddTimeOff}
          disabled={busyId === "addTimeOff"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addTimeOff" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>
    </div>
  );
}