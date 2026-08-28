"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Sprout } from "lucide-react";
import { useToast } from "@/components/Toast";
import { createClient } from "@/lib/supabase/client";
import AddressInput from "@/components/AddressInput";
import { isOfficeLike, isSuperAdmin } from "@/lib/roles";
import { generateDueDates } from "@/lib/lawnRecurrence";

// Dedicated lawn-job creator — lives INSIDE the Lawn tab. A lawn job is a
// `jobs` row with type='lawn' (so every existing jobs FK — photos, invoices,
// recurring_schedules, lawn_visits — keeps working) plus a 1:1 `lawn_jobs`
// property profile (gate code, pets, lot sqft, access, obstacles, sprinkler,
// map pin) plus a recurring_schedules row + seeded lawn_visits. Construction
// surfaces filter type='construction', so a job created here never shows up in
// Projects / dashboard / customer portal construction list / calendar job
// events / crew pickers — it stays in the Lawn tab.
//
// Lifted from admin/projects/new's createRecurring; the construction creator
// no longer has a recurring toggle (it's construction-only now).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVAL_BY_FREQUENCY: Record<string, number> = {
  weekly: 1,
  biweekly: 2,
  monthly: 4,
};
// Quick-pick sensitive-site flags (item 10) — matches LawnPropertyDetails.
const SENSITIVE_TAG_PRESETS = [
  "daycare",
  "school",
  "playground",
  "pets on site",
  "pond / water",
  "vegetable garden",
  "bee hives",
  "chemically sensitive",
] as const;

export default function NewLawnJobPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [crew, setCrew] = useState<{ id: string; name: string; user_id: string | null }[]>([]);
  const [lawnServices, setLawnServices] = useState<
    { id: string; name: string; default_price: number }[]
  >([]);

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [orgId, setOrgId] = useState<string>("");
  const toast = useToast();

  // ── Recurrence ────────────────────────────────────────────────────────────
  const [frequency, setFrequency] = useState<"weekly" | "biweekly" | "monthly">("weekly");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [seasonStart, setSeasonStart] = useState("");
  const [seasonEnd, setSeasonEnd] = useState("");
  const [servicePick, setServicePick] = useState("");
  const [customService, setCustomService] = useState("");
  const [pricePerVisit, setPricePerVisit] = useState("0");

  // ── Property profile (lawn_jobs 1:1) ─────────────────────────────────────
  const [lotSqft, setLotSqft] = useState("");
  const [gateCode, setGateCode] = useState("");
  const [pets, setPets] = useState("");
  const [accessNotes, setAccessNotes] = useState("");
  const [obstacles, setObstacles] = useState("");
  const [sprinkler, setSprinkler] = useState(false);
  const [mapLat, setMapLat] = useState("");
  const [mapLng, setMapLng] = useState("");
  const [sensitiveTags, setSensitiveTags] = useState<string[]>([]);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles").select("role, organization_id").eq("id", user.id).single();
      const role = profile?.role ?? "crew";
      if (isSuperAdmin(role) || !isOfficeLike(role) || !profile?.organization_id) {
        router.push("/dashboard");
        return;
      }
      setOrgId(profile.organization_id as string);
      const [{ data: custs }, { data: crews }, { data: services }] = await Promise.all([
        supabase.from("customers").select("id, name").order("name"),
        supabase.from("crew_members").select("id, name, user_id").order("name"),
        supabase.from("lawn_services").select("id, name, default_price").eq("active", true).order("name"),
      ]);
      setCustomers(custs ?? []);
      setCrew(crews ?? []);
      setLawnServices((services as { id: string; name: string; default_price: number }[]) ?? []);
    })();
  }, [router]);

  function toggleDay(d: number) {
    setDaysOfWeek((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  function toggleCrew(id: string) {
    setAssigned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function onServicePick(value: string) {
    setServicePick(value);
    if (value === "custom") {
      setCustomService("");
      return;
    }
    const svc = lawnServices.find((s) => s.id === value);
    if (svc) {
      setCustomService(svc.name);
      setPricePerVisit(String(svc.default_price ?? 0));
    }
  }

  function resolvedServiceType(): string | null {
    return customService.trim() || null;
  }

  function numOrNull(s: string): number | null {
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function validate(): string | null {
    if (!name.trim()) return "Pick a property name";
    if (!seasonStart) return "Pick a season start date";
    if (frequency !== "monthly" && daysOfWeek.length === 0)
      return "Pick at least one weekday";
    if (frequency === "monthly") {
      const dom = parseInt(dayOfMonth, 10);
      if (!dom || dom < 1 || dom > 28) return "Day of month must be 1–28";
    }
    if (!resolvedServiceType()) return "Pick or type a service";
    const price = parseFloat(pricePerVisit);
    if (isNaN(price) || price < 0) return "Price per visit must be 0 or more";
    return null;
  }

  // Insert the schedule + seed visits for a freshly created lawn job. Returns
  // the schedule id so the caller can route to /lawn/schedules/{id}. Generates
  // visits for the upcoming window only (max(start, today) → min(end,
  // today+90d)) so a job created mid-season doesn't back-fill dozens of rows.
  async function createRecurring(jobId: string, userId: string): Promise<{ scheduleId: string; visitCount: number }> {
    const supabase = createClient();
    const intervalWeeks = INTERVAL_BY_FREQUENCY[frequency] ?? 1;
    const scheduleRow = {
      job_id: jobId,
      // organization_id is NOT sent — trg_recurring_schedules_org stamps it
      // from job_id via set_org_from_job (same as every job-child table).
      frequency,
      interval_weeks: intervalWeeks,
      days_of_week: frequency === "monthly" ? [] : daysOfWeek,
      day_of_month: frequency === "monthly" ? parseInt(dayOfMonth, 10) : null,
      start_date: seasonStart,
      end_date: seasonEnd || null,
      service_type: resolvedServiceType(),
      price_per_visit: parseFloat(pricePerVisit) || 0,
      active: true,
      created_by: userId,
    };
    const { data: sched, error: schedErr } = await supabase
      .from("recurring_schedules")
      .insert(scheduleRow)
      .select("id")
      .single();
    if (schedErr || !sched) {
      throw new Error(`Schedule failed: ${schedErr?.message ?? "error"}`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const genFrom = seasonStart > today ? seasonStart : today;
    const todayPlus90 = new Date();
    todayPlus90.setUTCDate(todayPlus90.getUTCDate() + 90);
    let genTo = todayPlus90.toISOString().slice(0, 10);
    if (seasonEnd && seasonEnd < genTo) genTo = seasonEnd;
    const dueDates = generateDueDates(
      {
        frequency,
        interval_weeks: intervalWeeks,
        days_of_week: frequency === "monthly" ? [] : daysOfWeek,
        day_of_month: frequency === "monthly" ? parseInt(dayOfMonth, 10) : null,
        start_date: seasonStart,
        end_date: seasonEnd || null,
      },
      genFrom,
      genTo
    );
    if (dueDates.length > 0) {
      const visits = dueDates.map((due_date) => ({
        recurring_schedule_id: sched.id,
        job_id: jobId,
        due_date,
        status: "pending" as const,
      }));
      const { error: visitErr } = await supabase.from("lawn_visits").insert(visits);
      if (visitErr && visitErr.code !== "23505") {
        throw new Error(`Visits failed: ${visitErr.message}`);
      }
    }
    return { scheduleId: sched.id, visitCount: dueDates.length };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const vErr = validate();
    if (vErr) {
      toast.warning(vErr);
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setLoading(false);
      return;
    }

    // 1. The lawn job. type='lawn' isolates it from every construction surface
    //    (those filter type='construction'). No scheduled_start/end — a lawn
    //    job's dates come from its recurring schedule, not job-level dates.
    const { data, error } = await supabase.from("jobs").insert({
      customer_id: customerId || null,
      name,
      address: address || null,
      description: description || null,
      status: "scheduled",
      assigned_crew: assigned,
      organization_id: orgId,
      type: "lawn",
    }).select().single();
    if (error) {
      toast.error(`Failed to create: ${error.message}`);
      setLoading(false);
      return;
    }

    // 2. The 1:1 property profile (lawn_jobs). id = the job id; app supplies
    //    organization_id (lawn_jobs.id is the job id, not a job_id column, so
    //    there's no set_org_from_job trigger on it). Optional fields are sent
    //    as null when blank. A failure here does NOT roll back the job — the
    //    job exists and the schedule can still be created; the office can edit
    //    the profile from the schedule detail page.
    const { error: profileErr } = await supabase.from("lawn_jobs").insert({
      id: data.id,
      organization_id: orgId,
      lot_sqft: numOrNull(lotSqft),
      gate_code: gateCode.trim() || null,
      pets: pets.trim() || null,
      access_notes: accessNotes.trim() || null,
      obstacles: obstacles.trim() || null,
      sprinkler,
      map_lat: numOrNull(mapLat),
      map_lng: numOrNull(mapLng),
      sensitive_site_tags: sensitiveTags,
    });
    if (profileErr) {
      toast.error(`Job created, but property profile failed: ${profileErr.message}`);
      setTimeout(() => router.push(`/jobs/${data.id}`), 1200);
      return;
    }

    // 3. The recurring schedule + seeded visits.
    try {
      const { scheduleId, visitCount } = await createRecurring(data.id, user.id);
      toast.success(
        visitCount > 0
          ? `Lawn job created · ${visitCount} upcoming visits seeded`
          : "Lawn job created"
      );
      setTimeout(() => router.push(`/lawn/schedules/${scheduleId}`), 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      toast.error(`Job created, but recurring setup failed: ${msg}`);
      setTimeout(() => router.push(`/jobs/${data.id}`), 1200);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24 lg:pb-10">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <button
          onClick={() => router.push("/lawn")}
          className="text-sm text-green-700 px-2 py-1 -ml-2 flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Lawn
        </button>
        <h1 className="text-lg font-bold text-gray-900 absolute left-1/2 -translate-x-1/2 max-w-[50%] truncate flex items-center gap-1.5">
          <Sprout className="w-5 h-5 text-green-600" />
          New Lawn Job
        </h1>
        <div className="w-16" />
      </header>

      <main className="max-w-md lg:max-w-2xl mx-auto p-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-lg p-4 shadow-sm space-y-4">
          {/* Property */}
          <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Property</p>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Property Name *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="Smith Residence"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Customer</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
            >
              <option value="">— Select customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Service Address</span>
            <AddressInput
              value={address}
              onChange={setAddress}
              className="mt-1 block w-full px-3 py-3 border border-gray-300 rounded-lg text-base"
              placeholder="123 Main St, City"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Notes</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg text-base"
              placeholder="Corner lot, steep front slope, narrow side gate…"
            />
          </label>

          {crew.length > 0 && (
            <div>
              <span className="text-sm font-medium text-gray-700">Assign Crew</span>
              <div className="mt-2 space-y-2">
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
                      <p className="text-sm font-medium text-gray-900">{c.name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {c.user_id ? "App user" : "Scheduling only — no app login"}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Property details (lawn_jobs profile) */}
          <div className="border-t border-gray-200 pt-4 space-y-3">
            <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">
              Property Details
            </p>

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
              <span className="text-sm font-medium text-gray-700">Sprinkler system (avoid overspray)</span>
            </label>

            {/* Sensitive-site flags (item 10) — stored on the lawn_jobs profile
                and shown as a warning strip to crew on every visit. */}
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-gray-700">
                Sensitive site flags
              </span>
              <div className="flex flex-wrap gap-1.5">
                {SENSITIVE_TAG_PRESETS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() =>
                      setSensitiveTags((prev) =>
                        prev.includes(tag)
                          ? prev.filter((t) => t !== tag)
                          : [...prev, tag]
                      )
                    }
                    className={`text-[11px] font-medium rounded-full px-2.5 py-1 border ${
                      sensitiveTags.includes(tag)
                        ? "bg-amber-100 border-amber-300 text-amber-800"
                        : "bg-white border-gray-300 text-gray-500"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Map lat (opt.)</span>
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
                <span className="text-sm font-medium text-gray-700">Map lng (opt.)</span>
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
          </div>

          {/* Recurrence */}
          <div className="border-t border-gray-200 pt-4 space-y-3">
            <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">
              Recurrence
            </p>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Frequency *</span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as "weekly" | "biweekly" | "monthly")}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly (every 2 weeks)</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>

            {frequency === "monthly" ? (
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Day of month (1–28) *</span>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                  placeholder="15"
                />
              </label>
            ) : (
              <div>
                <span className="text-sm font-medium text-gray-700">Weekdays *</span>
                <div className="mt-2 grid grid-cols-7 gap-1">
                  {WEEKDAYS.map((label, d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDay(d)}
                      className={`py-2 rounded-md text-xs font-semibold ${
                        daysOfWeek.includes(d)
                          ? "bg-green-600 text-white"
                          : "bg-white border border-gray-300 text-gray-600"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Season start *</span>
                <input
                  type="date"
                  value={seasonStart}
                  onChange={(e) => setSeasonStart(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Season end (opt.)</span>
                <input
                  type="date"
                  value={seasonEnd}
                  onChange={(e) => setSeasonEnd(e.target.value)}
                  className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Service *</span>
              <select
                value={servicePick}
                onChange={(e) => onServicePick(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
              >
                <option value="">Select service</option>
                {lawnServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="custom">Other (type your own)</option>
              </select>
              {servicePick === "custom" && (
                <input
                  type="text"
                  value={customService}
                  onChange={(e) => setCustomService(e.target.value)}
                  placeholder="e.g. Sprinkler winterization"
                  className="mt-2 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                />
              )}
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Price per visit *</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={pricePerVisit}
                onChange={(e) => setPricePerVisit(e.target.value)}
                className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
                placeholder="45.00"
              />
            </label>

            <p className="text-xs text-gray-500">
              Visits for the next ~90 days (within the season) are created automatically —
              generate more from the schedule later.
            </p>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-green-600 text-white py-4 rounded-lg font-semibold text-base active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-5 h-5 animate-spin" />}
            {loading ? "Creating..." : "Create Lawn Job"}
          </button>
        </form>
      </main>
    </div>
  );
}