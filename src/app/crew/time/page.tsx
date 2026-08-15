"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import TopBar from "@/components/TopBar";
import { useToast } from "@/components/Toast";
import { Play, Square, Loader2, MapPin, Clock, Trash2, AlertCircle } from "lucide-react";
import { resolveLocation, type GpsResult, type GpsStatus, type GpsSource } from "@/lib/geo";

type CostCode = { id: string; code: string; name: string };
type Job = { id: string; name: string };
type TimeEntry = {
  id: string;
  job_id: string;
  cost_code_id: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  note: string | null;
  lat: number | null;
  lng: number | null;
  location_source: GpsSource | null;
};

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function CrewTimePage() {
  const supabase = createClient();
  const toast = useToast();

  const [userId, setUserId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [recent, setRecent] = useState<TimeEntry[]>([]);
  const [jobNameById, setJobNameById] = useState<Record<string, string>>({});
  const [codeLabelById, setCodeLabelById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // Clock-in form
  const [jobId, setJobId] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [note, setNote] = useState("");
  const [gps, setGps] = useState<GpsResult | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("getting");
  const [busy, setBusy] = useState(false);

  // Ticking "now" for the live elapsed timer
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    // No synchronous setLoading(true) — initial state is already `true`, so
    // the mount effect triggers no setState in the effect body.
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);

    const [jobsR, codesR, entriesR] = await Promise.all([
      supabase.from("jobs").select("id, name").eq("type", "construction").order("name"),
      supabase.from("cost_codes").select("id, code, name").order("code"),
      user?.id
        ? supabase
            .from("time_entries")
            .select("id, job_id, cost_code_id, clock_in_at, clock_out_at, note, lat, lng, location_source")
            .eq("user_id", user.id)
            .order("clock_in_at", { ascending: false })
            .limit(50)
        : { data: [] },
    ]);

    const j = (jobsR.data as Job[]) ?? [];
    const c = (codesR.data as CostCode[]) ?? [];
    const e = (entriesR.data as TimeEntry[]) ?? [];
    setJobs(j);
    setCostCodes(c);
    setJobNameById(Object.fromEntries(j.map((x) => [x.id, x.name])));
    setCodeLabelById(Object.fromEntries(c.map((x) => [x.id, `${x.code} · ${x.name}`])));
    setOpenEntry(e.find((x) => !x.clock_out_at) ?? null);
    setRecent(e.filter((x) => x.clock_out_at).slice(0, 20));
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      await load();
      // Auto-grab location on open so it's ready at clock-in — no manual tap.
      await getLocation();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick every second while clocked in
  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [openEntry]);

  // High-accuracy GPS, falling back to approximate IP location if denied.
  // Initial status is "getting" (set in useState) so we don't setState
  // synchronously inside the mount effect.
  async function getLocation() {
    const { result, status } = await resolveLocation();
    setGps(result);
    setGpsStatus(status);
  }

  async function clockIn(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) {
      toast.error("Not signed in");
      return;
    }
    if (!jobId) {
      toast.warning("Pick a job");
      return;
    }
    if (openEntry) {
      toast.warning("You're already clocked in — clock out first");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase
      .from("time_entries")
      .insert({
        user_id: userId,
        job_id: jobId,
        cost_code_id: costCodeId || null,
        note: note.trim() || null,
        lat: gps?.lat ?? null,
        lng: gps?.lng ?? null,
        location_source: gps?.source ?? null,
        location_accuracy: gps?.accuracy ?? null,
      })
      .select("id, job_id, cost_code_id, clock_in_at, clock_out_at, note, lat, lng, location_source")
      .single();
    if (error) {
      toast.error(
        error.code === "42501"
          ? "Not assigned to that job — ask the office to assign you first."
          : error.message
      );
    } else if (data) {
      setOpenEntry(data);
      setNow(Date.now());
      toast.success("Clocked in");
      setNote("");
      setGps(null);
      setGpsStatus("getting");
      getLocation();
    }
    setBusy(false);
  }

  async function clockOut() {
    if (!openEntry) return;
    setBusy(true);
    const { error } = await supabase
      .from("time_entries")
      .update({ clock_out_at: new Date().toISOString() })
      .eq("id", openEntry.id);
    if (error) {
      toast.error(error.message);
    } else {
      setRecent((prev) => [{ ...openEntry, clock_out_at: new Date().toISOString() }, ...prev].slice(0, 20));
      setOpenEntry(null);
      toast.success("Clocked out");
    }
    setBusy(false);
  }

  async function removeEntry(entry: TimeEntry) {
    if (!confirm("Delete this time entry? This can't be undone.")) return;
    const { error } = await supabase.from("time_entries").delete().eq("id", entry.id);
    if (error) {
      toast.error(error.message);
    } else {
      setRecent((prev) => prev.filter((x) => x.id !== entry.id));
      toast.success("Deleted");
    }
  }

  const elapsed = openEntry ? now - new Date(openEntry.clock_in_at).getTime() : 0;

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <TopBar title="Time Clock" />
      <main className="max-w-md mx-auto p-4 space-y-4">
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-7 h-7 animate-spin text-gray-400" />
          </div>
        ) : openEntry ? (
          /* ---- Clocked in: show the live timer + clock out ---- */
          <div className="bg-white rounded-lg p-4 shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-green-700">
              <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-semibold uppercase">On the clock</span>
            </div>
            <div className="text-center py-2">
              <p className="font-mono text-4xl font-bold tabular-nums text-gray-900">
                {fmtDuration(elapsed)}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Since {new Date(openEntry.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
            <div className="text-sm text-gray-700 space-y-0.5">
              <p className="font-medium truncate">{jobNameById[openEntry.job_id] ?? "—"}</p>
              {openEntry.cost_code_id && (
                <p className="text-xs text-gray-500 truncate">
                  {codeLabelById[openEntry.cost_code_id]}
                </p>
              )}
              {openEntry.note && <p className="text-xs text-gray-500">{openEntry.note}</p>}
              {typeof openEntry.lat === "number" && typeof openEntry.lng === "number" && (
                <a
                  href={`https://www.google.com/maps?q=${openEntry.lat},${openEntry.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex items-center gap-1 text-xs hover:underline mt-1 ${
                    openEntry.location_source === "ip" ? "text-amber-600" : "text-blue-600"
                  }`}
                >
                  <MapPin className="w-3 h-3" />
                  {openEntry.location_source === "ip"
                    ? `Clocked in (approx) at ${openEntry.lat.toFixed(3)}, ${openEntry.lng.toFixed(3)}`
                    : `Clocked in at ${openEntry.lat.toFixed(4)}, ${openEntry.lng.toFixed(4)}`}
                </a>
              )}
            </div>
            <button
              onClick={clockOut}
              disabled={busy}
              className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold active:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Square className="w-5 h-5" />}
              Clock Out
            </button>
          </div>
        ) : (
          /* ---- Clocked out: clock-in form ---- */
          <form onSubmit={clockIn} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Job</span>
              <select
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                required
                className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              >
                <option value="">Select job</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.name}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Cost code (optional)</span>
              <select
                value={costCodeId}
                onChange={(e) => setCostCodeId(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base bg-white"
              >
                <option value="">No code</option>
                {costCodes.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Note (optional)</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What are you working on?"
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              />
            </label>

            {/* Location — auto-captured on page open */}
            <div className="text-xs space-y-1.5">
              {gpsStatus === "ok" && gps ? (
                <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 px-2 py-1 rounded">
                  <MapPin className="w-3.5 h-3.5" />
                  Location tagged · {gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}
                  {gps.accuracy ? ` (±${Math.round(gps.accuracy)}m)` : ""}
                </span>
              ) : gpsStatus === "ip" && gps ? (
                <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-1 rounded">
                  <MapPin className="w-3.5 h-3.5" />
                  Approximate location (network) · {gps.lat.toFixed(3)}, {gps.lng.toFixed(3)}
                </span>
              ) : gpsStatus === "getting" ? (
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Getting location…
                </span>
              ) : gpsStatus === "denied" || gpsStatus === "unavailable" ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 space-y-1.5">
                  <p className="flex items-center gap-1.5 text-amber-800 font-medium">
                    <AlertCircle className="w-4 h-4" />
                    Location is off — clock-in pin will be blank
                  </p>
                  <p className="text-amber-700">
                    Enable location in your phone/browser settings to record
                    exactly where you clocked in.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setGpsStatus("getting");
                      getLocation();
                    }}
                    className="inline-flex items-center gap-1 text-amber-900 font-semibold underline"
                  >
                    <MapPin className="w-3.5 h-3.5" />
                    Try again
                  </button>
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-green-600 text-white py-4 rounded-lg font-semibold text-base active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
              Clock In
            </button>
          </form>
        )}

        {/* Recent entries */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 flex items-center gap-1">
            <Clock className="w-4 h-4" />
            Recent Shifts
          </h2>
          {recent.length === 0 ? (
            <div className="bg-white rounded-lg p-6 text-center">
              <p className="text-sm text-gray-500">No past shifts yet</p>
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {recent.map((e) => {
                const dur = new Date(e.clock_out_at!).getTime() - new Date(e.clock_in_at).getTime();
                return (
                  <div key={e.id} className="p-3 flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {jobNameById[e.job_id] ?? "—"}
                      </p>
                      <p className="text-xs text-gray-500">
                        {new Date(e.clock_in_at).toLocaleDateString([], { month: "short", day: "numeric" })} ·{" "}
                        {new Date(e.clock_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        {" → "}
                        {new Date(e.clock_out_at!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                      {e.cost_code_id && (
                        <p className="text-xs text-blue-600 truncate">{codeLabelById[e.cost_code_id]}</p>
                      )}
                    </div>
                    <span className="font-mono text-sm font-semibold text-gray-700 tabular-nums">
                      {fmtDuration(dur)}
                    </span>
                    <button
                      onClick={() => removeEntry(e)}
                      className="text-red-600 p-1.5 rounded hover:bg-red-50 flex-shrink-0"
                      title="Delete entry"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}